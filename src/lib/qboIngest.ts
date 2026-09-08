import type { QboConnection } from "@prisma/client";
import prisma from "./prisma";
import logger from "./logger";
import { queryAll, qboFetch, qboConnectionFor, qboConnected } from "./qbo";

/**
 * Ingest QuickBooks reference data into the raw_<entity>_qb tables.
 *
 * Why cache at all: the customer picker, the org tax-rate pre-fill and the income-account picker
 * are all typed-into-a-box interactions. Hitting Intuit on every keystroke would be slow, would
 * burn the app's shared rate limit across every client, and would make the settings screens fail
 * whenever QuickBooks is down. So we sync on demand and read locally.
 *
 * Three rules hold everywhere in this file:
 *  - Company-scoped. Every row carries company_id and every query filters on it.
 *  - Never a source of truth. These tables mirror someone else's system; CLARA's own settings
 *    always win, and a company with no QuickBooks connection simply has no rows.
 *  - Upsert, never truncate-and-insert. A sync that fails halfway must not leave a company with
 *    an empty customer list, and ids other rows point at must survive.
 *
 * Our CLARA-item -> QBO-item-id mapping lives in `qbo_item_links`, NOT in these tables. The
 * separation is deliberate: raw_*_qb mirrors Intuit's data and can be re-synced at any time,
 * while a link records a decision we made and must never be lost. See `ensureQboItem`.
 */

/** What a sync did, per entity, so the caller can report it and we can log it. */
export interface IngestCounts {
  customers: number;
  items: number;
  taxCodes: number;
  taxRates: number;
  accounts: number;
}

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v);
  return s || null;
};

/** QBO ids are numeric strings; normalise so a numeric 5 and "5" cannot become two rows. */
const id = (v: unknown): string => String(v ?? "").trim();

/**
 * Item names are matched case-insensitively (QBO itself is case-insensitive on Name), and the
 * registry's uniqueness is (company_id, name) — so store the casefolded name and keep the
 * display casing in `raw`. Without this, "12 AWG Wire" and "12 awg wire" become two QBO items.
 */
export const itemKey = (name: string) => name.trim().toLowerCase().slice(0, 100);

// ---------- customers: entity + customer_qb ----------

interface QboCustomerRow {
  Id: string;
  DisplayName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  BillAddr?: { Line1?: string; City?: string; CountrySubDivisionCode?: string; PostalCode?: string };
  Active?: boolean;
}

const addrLine = (a?: QboCustomerRow["BillAddr"]): string | null =>
  a ? str([a.Line1, a.City, a.CountrySubDivisionCode, a.PostalCode].filter(Boolean).join(", ")) : null;

/**
 * Ingest customers into `customers` (the entity) and `customer_qb` (what QuickBooks knows).
 *
 * Matched on the QBO id first, so a rename in QuickBooks moves the existing row rather than
 * creating a second customer. Falling back to the name is what adopts a customer CLARA already
 * had before the company connected — otherwise the first sync would duplicate every one of them.
 *
 * Our own name/email/phone are only filled in where they are EMPTY. A technician who corrected a
 * phone number here should not have it overwritten by whatever the books happen to hold.
 */
async function ingestCustomers(
  conn: QboConnection,
  companyId: number,
  realmId: string
): Promise<number> {
  const rows = await queryAll<QboCustomerRow>(conn, "Customer");
  for (const r of rows) {
    const qboId = id(r.Id);
    const displayName = str(r.DisplayName) ?? `Customer ${qboId}`;
    const email = str(r.PrimaryEmailAddr?.Address);
    const phone = str(r.PrimaryPhone?.FreeFormNumber);
    const address = addrLine(r.BillAddr);

    const linked = await prisma.customerQb.findUnique({
      where: { companyId_realmId_qboId: { companyId, realmId, qboId } },
      select: { customerId: true },
    });
    const byName = linked
      ? null
      : await prisma.customer.findUnique({
          where: { companyId_name: { companyId, name: displayName } },
          select: { id: true },
        });

    const customerId =
      linked?.customerId ??
      byName?.id ??
      (
        await prisma.customer.create({
          data: { companyId, name: displayName, email, phone, address, active: r.Active !== false },
        })
      ).id;

    // Fill gaps only — never clobber what someone typed here.
    const current = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { email: true, phone: true, address: true },
    });
    await prisma.customer.update({
      where: { id: customerId },
      data: {
        email: current?.email ?? email,
        phone: current?.phone ?? phone,
        address: current?.address ?? address,
      },
    });

    const qb = { qboId, displayName, raw: r as object, syncedAt: new Date() };
    await prisma.customerQb.upsert({
      where: { customerId_realmId: { customerId, realmId } },
      create: { customerId, companyId, realmId, ...qb },
      update: qb,
    });
  }
  return rows.length;
}

// ---------- items (US5, and the registry) ----------

interface QboItemRow {
  Id: string;
  Name?: string;
  Type?: string;
  Taxable?: boolean;
  Active?: boolean;
}

async function ingestItems(conn: QboConnection, companyId: number): Promise<number> {
  const rows = await queryAll<QboItemRow>(conn, "Item");
  for (const r of rows) {
    const name = itemKey(str(r.Name) ?? `item-${id(r.Id)}`);
    const data = {
      name,
      type: str(r.Type),
      taxable: r.Taxable ?? null,
      active: r.Active !== false,
      raw: r as object,
      syncedAt: new Date(),
    };
    // Keyed on the QBO id, not the name: a rename in QuickBooks must move the existing row
    // rather than orphan it and add a second one.
    await prisma.rawQbItem.upsert({
      where: { companyId_qboId: { companyId, qboId: id(r.Id) } },
      create: { companyId, qboId: id(r.Id), ...data },
      update: data,
    });
  }
  return rows.length;
}

// ---------- sales tax: entity + sales_tax_qb ----------

interface QboTaxRateRow {
  Id: string;
  Name?: string;
  RateValue?: number | string;
  Active?: boolean;
}

interface QboTaxRateDetail {
  TaxRateRef?: { value?: string; name?: string };
  /** "TaxOnAmount" (on the net) or "TaxOnAmountPlusTax" (compounded on net + tax so far). */
  TaxTypeApplicable?: string;
  TaxOrder?: number;
}

interface QboTaxCodeRow {
  Id: string;
  Name?: string;
  /** True when this code is a GROUP of rates. False for the pseudo codes TAX and NON. */
  TaxGroup?: boolean;
  /** "False or null means non-taxable. Always true, except for the pseudo taxcode NON." */
  Taxable?: boolean;
  Active?: boolean;
  SalesTaxRateList?: { TaxRateDetail?: QboTaxRateDetail[] };
}

/**
 * The percentage a tax CODE actually charges.
 *
 * A code is what a transaction line references, and in QuickBooks it is usually a group of
 * rates — so the rate that matters is the group's, not any one member's. Measured on the
 * sandbox: the code "Tucson" is AZ State tax 7.1% + Tucson City 2%, i.e. 9.1%. Matching a code
 * to a rate of the same name would have linked it to Tucson City alone and understated tax by
 * 7.1 points.
 *
 * Members are cascaded in `TaxOrder`: "TaxOnAmount" adds to the net, while
 * "TaxOnAmountPlusTax" compounds on the net plus the tax accumulated before it. Every rate in
 * the sandbox is TaxOnAmount, so the cascade is a plain sum there — it is implemented properly
 * anyway, because getting it wrong is silent and lands in customer money.
 */
export function taxGroupEffectiveRate(
  details: QboTaxRateDetail[],
  rateById: Map<string, number>
): number {
  let effective = 0;
  const ordered = [...details].sort((a, b) => (a.TaxOrder ?? 0) - (b.TaxOrder ?? 0));
  for (const d of ordered) {
    const value = rateById.get(String(d.TaxRateRef?.value ?? ""));
    if (value == null || !Number.isFinite(value)) continue;
    effective +=
      d.TaxTypeApplicable === "TaxOnAmountPlusTax" ? value * (1 + effective / 100) : value;
  }
  // Four decimals: the column's precision, and enough for a compounded cascade.
  return Math.round(effective * 10000) / 10000;
}

/**
 * Ingest QuickBooks tax into `sales_tax` (what CLARA applies) and `sales_tax_qb`.
 *
 * Driven by tax CODES, because a code is the thing a transaction line can reference. Each code
 * becomes one CLARA rate carrying the group's effective percentage, and gets `_qb` rows for the
 * code itself plus every rate it is built from — which is why `qboType` is part of that table's
 * key, and what lets a later feature reconstruct the breakdown.
 *
 * Skipped on purpose:
 *  - the pseudo codes TAX and NON (`TaxGroup: false`) — they carry no rate of their own;
 *  - non-taxable codes;
 *  - groups with no members, like the sandbox's "CustomSalesTax" — importing a 0% candidate
 *    named after a real jurisdiction is worse than not offering it.
 *
 * Rates arrive as candidates, never as the default. Which rate an estimate uses is an admin's
 * decision in tax settings; importing one silently would start taxing every new estimate the
 * moment someone connected QuickBooks.
 */
async function ingestSalesTax(
  conn: QboConnection,
  companyId: number,
  realmId: string
): Promise<{ taxCodes: number; taxRates: number }> {
  const rates = await queryAll<QboTaxRateRow>(conn, "TaxRate");
  const rateById = new Map<string, number>();
  const rateNameById = new Map<string, string>();
  for (const r of rates) {
    const value = r.RateValue == null ? null : Number(r.RateValue);
    if (value == null || !Number.isFinite(value)) continue;
    rateById.set(id(r.Id), value);
    rateNameById.set(id(r.Id), str(r.Name) ?? `TaxRate ${id(r.Id)}`);
  }

  const codes = await queryAll<QboTaxCodeRow>(conn, "TaxCode");
  let imported = 0;
  for (const c of codes) {
    if (c.Active === false || c.Taxable === false || c.TaxGroup !== true) continue;
    const details = c.SalesTaxRateList?.TaxRateDetail ?? [];
    if (details.length === 0) continue;

    const effective = taxGroupEffectiveRate(details, rateById);
    const name = str(c.Name) ?? `TaxCode ${id(c.Id)}`;

    const existing = await prisma.salesTax.findUnique({
      where: { companyId_name: { companyId, name } },
      select: { id: true },
    });
    // An existing rate has its percentage refreshed — a jurisdiction changing its rate is the
    // normal case — but `isDefault` is never touched here. That is the admin's choice.
    const salesTaxId = existing
      ? (
          await prisma.salesTax.update({
            where: { id: existing.id },
            data: { ratePercent: effective, active: true },
          })
        ).id
      : (
          await prisma.salesTax.create({
            data: { companyId, name, ratePercent: effective },
          })
        ).id;

    const codeQb = { name, raw: c as object, syncedAt: new Date() };
    await prisma.salesTaxQb.upsert({
      where: {
        companyId_realmId_qboType_qboId: { companyId, realmId, qboType: "TaxCode", qboId: id(c.Id) },
      },
      create: { salesTaxId, companyId, realmId, qboType: "TaxCode", qboId: id(c.Id), ...codeQb },
      update: codeQb,
    });

    // The members, so the breakdown behind the number is recoverable without a re-sync.
    for (const d of details) {
      const rid = String(d.TaxRateRef?.value ?? "");
      if (!rateById.has(rid)) continue;
      const rateQb = {
        name: rateNameById.get(rid) ?? rid,
        raw: d as object,
        syncedAt: new Date(),
      };
      await prisma.salesTaxQb.upsert({
        where: {
          companyId_realmId_qboType_qboId: {
            companyId,
            realmId,
            qboType: "TaxRate",
            qboId: rid,
          },
        },
        create: { salesTaxId, companyId, realmId, qboType: "TaxRate", qboId: rid, ...rateQb },
        update: rateQb,
      });
    }
    imported++;
  }

  logger.info("QBO sales tax ingested", { companyId, codes: imported, rates: rateById.size });
  return { taxCodes: imported, taxRates: rateById.size };
}

// ---------- accounts (fixes G10: no more "first Income account found") ----------

interface QboAccountRow {
  Id: string;
  Name?: string;
  AccountType?: string;
  AccountSubType?: string;
  Active?: boolean;
}

async function ingestAccounts(conn: QboConnection, companyId: number): Promise<number> {
  const rows = await queryAll<QboAccountRow>(conn, "Account");
  for (const r of rows) {
    const data = {
      name: str(r.Name) ?? `Account ${id(r.Id)}`,
      accountType: str(r.AccountType),
      accountSubType: str(r.AccountSubType),
      active: r.Active !== false,
      raw: r as object,
      syncedAt: new Date(),
    };
    await prisma.rawQbAccount.upsert({
      where: { companyId_qboId: { companyId, qboId: id(r.Id) } },
      create: { companyId, qboId: id(r.Id), ...data },
      update: data,
    });
  }
  return rows.length;
}

// ---------- the sync ----------

/**
 * Pull every reference entity for one company. Entities are ingested in sequence, not in
 * parallel: they share one access token whose refresh is not yet serialised (T-02), and Intuit
 * rate-limits per app — which for a Clara-owned app is shared across every client.
 *
 * Throws if the company is not connected. Callers decide whether that is a 409 or a no-op.
 */
export async function syncQboReferenceData(companyId: number): Promise<IngestCounts> {
  const conn = await qboConnectionFor(companyId);
  if (!qboConnected(conn)) throw new Error("QuickBooks is not connected for this company");
  const realmId = conn.realmId;
  if (!realmId) throw new Error("QuickBooks connection has no realm — reconnect from Settings");

  const customers = await ingestCustomers(conn, companyId, realmId);
  const items = await ingestItems(conn, companyId);
  const tax = await ingestSalesTax(conn, companyId, realmId);
  const accounts = await ingestAccounts(conn, companyId);

  const counts: IngestCounts = { customers, items, accounts, ...tax };
  logger.info("QBO reference data synced", { companyId, realmId, ...counts });
  return counts;
}

// ---------- reads for the UI ----------

/**
 * Customer typeahead. Empty query returns the first page so the picker has something to show
 * before anyone types. Inactive customers are excluded: they cannot be billed.
 */
/**
 * Customer typeahead. Reads the `customers` entity, not the QuickBooks mirror, so the picker
 * works identically for a company with no accounting integration at all. Whether a customer is
 * synced is reported alongside, because that is what the estimate screen needs to show.
 */
export async function searchCustomers(companyId: number, q: string, limit = 20) {
  const term = q.trim();
  const rows = await prisma.customer.findMany({
    where: {
      companyId,
      active: true,
      ...(term ? { name: { contains: term, mode: "insensitive" as const } } : {}),
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      qb: { select: { qboId: true, realmId: true }, take: 1 },
    },
    orderBy: { name: "asc" },
    take: Math.min(limit, 50),
  });
  return rows.map(({ qb, ...c }) => ({ ...c, qboId: qb[0]?.qboId ?? null }));
}

/** Income accounts, for the admin to choose what created items bill against (G10). */
export function qboIncomeAccounts(companyId: number) {
  return prisma.rawQbAccount.findMany({
    where: { companyId, active: true, accountType: "Income" },
    select: { qboId: true, name: true, accountSubType: true },
    orderBy: { name: "asc" },
  });
}

/**
 * The company's sales-tax rates and which one is the default. Readable by every role: an
 * estimate has to show the rate it is applying, and gating this would blank the totals for
 * technicians.
 */
export function listSalesTax(companyId: number) {
  return prisma.salesTax.findMany({
    where: { companyId },
    select: {
      id: true,
      name: true,
      ratePercent: true,
      isDefault: true,
      active: true,
      qb: { select: { qboType: true, qboId: true }, orderBy: { qboType: "asc" } },
    },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });
}

/** The rate a new estimate starts with, or null when the company has not chosen one. */
export function defaultSalesTax(companyId: number) {
  return prisma.salesTax.findFirst({
    where: { companyId, isDefault: true, active: true },
    select: { id: true, name: true, ratePercent: true },
  });
}

/** When reference data was last pulled, so the UI can offer a refresh instead of guessing. */
export async function qboSyncedAt(companyId: number): Promise<Date | null> {
  const newest = await prisma.customerQb.findFirst({
    where: { companyId },
    select: { syncedAt: true },
    orderBy: { syncedAt: "desc" },
  });
  return newest?.syncedAt ?? null;
}

// ---------- the item registry ----------

/** How a CLARA line identifies its item. A pricebook row when it has one, else its name. */
export interface ItemIdentity {
  /** pricebook_items.id — the stable identity, preferred whenever the line came from a book. */
  pricebookItemId?: number | null;
  /** The item name to create in QuickBooks, and the fallback key for lines with no book row. */
  name: string;
  taxable?: boolean | null;
  incomeAccountId?: string | null;
}

/**
 * Resolve one line's item to a QuickBooks item id, creating the item only if it does not exist,
 * and remembering the id so it is never created twice.
 *
 * This is the product rule from 2026-09-07: sync an item once, reuse its id everywhere after.
 * Because an estimate cannot reference an item that has no id, items are ensured BEFORE the
 * estimate payload is built and the ids returned here are what the estimate carries.
 *
 * Resolution order, cheapest and most stable first:
 *  1. `qbo_item_links` by pricebook item — survives a rename on either side;
 *  2. `qbo_item_links` by casefolded name — labor and ad-hoc lines, which have no book row
 *     (46% of production lines, and every labor line);
 *  3. the ingested mirror, then a live name query — catches an item that already exists in
 *     QuickBooks, so we adopt it instead of creating a duplicate;
 *  4. create it, and link it.
 *
 * Every lookup is scoped to the connection's realm: ids from a different QuickBooks file are
 * not ours to reuse.
 */
export async function ensureQboItem(
  conn: QboConnection,
  companyId: number,
  identity: ItemIdentity
): Promise<string> {
  const realmId = conn.realmId;
  if (!realmId) throw new Error("QuickBooks connection has no realm — reconnect from Settings");
  const key = itemKey(identity.name);
  const scope = { companyId, realmId };

  // 1 + 2: an id we have already decided on.
  const linked = await prisma.qboItemLink.findFirst({
    where: {
      ...scope,
      OR: [
        ...(identity.pricebookItemId != null
          ? [{ pricebookItemId: identity.pricebookItemId }]
          : []),
        { itemKey: key },
      ],
    },
    select: { qboItemId: true },
  });
  if (linked) return linked.qboItemId;

  // 3: it may already exist in QuickBooks — check the mirror first, then ask, so a company that
  // has synced pays no API call here.
  const mirrored = await prisma.rawQbItem.findUnique({
    where: { companyId_name: { companyId, name: key } },
    select: { qboId: true, raw: true },
  });
  if (mirrored) {
    await linkItem(scope, identity, key, mirrored.qboId, false);
    return mirrored.qboId;
  }
  const found = await queryAll<{ Id: string; Type?: string; Taxable?: boolean }>(
    conn,
    "Item",
    `Name = '${esc(key)}'`,
    { pageSize: 1, maxPages: 1 }
  );
  if (found[0]) {
    await linkItem(scope, identity, key, String(found[0].Id), false);
    return String(found[0].Id);
  }

  // 4: create, then link.
  const accountId =
    identity.incomeAccountId ?? (await firstIncomeAccountId(conn, companyId));
  if (!accountId) throw new Error("QBO company has no Income account to bill items against");
  const created = await qboFetch(conn, "/item", {
    method: "POST",
    body: JSON.stringify({
      Name: identity.name.trim().slice(0, 100),
      Type: "Service",
      IncomeAccountRef: { value: accountId },
      // Set at creation because QuickBooks applies it to every future line billed against this
      // item; leaving it to QBO's default is G14.
      ...(identity.taxable == null ? {} : { Taxable: identity.taxable }),
    }),
  });
  const newId = String(created.Item.Id);
  await linkItem(scope, identity, key, newId, true);
  logger.info("QBO item created and linked", {
    companyId,
    name: key,
    qboItemId: newId,
    pricebookItemId: identity.pricebookItemId ?? null,
  });
  return newId;
}

/** QBO query literals escape single quotes with a backslash. */
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/**
 * Record the mapping. Keyed on the pricebook item when there is one, otherwise on the name.
 *
 * A unique violation is swallowed: two quote completions can race to create the same item, and
 * the loser should adopt the winner's row rather than fail a technician's completion. The id is
 * already in hand either way, so the caller loses nothing.
 */
async function linkItem(
  scope: { companyId: number; realmId: string },
  identity: ItemIdentity,
  key: string,
  qboItemId: string,
  createdByClara: boolean
) {
  const byPricebook = identity.pricebookItemId != null;
  try {
    await prisma.qboItemLink.create({
      data: {
        ...scope,
        pricebookItemId: byPricebook ? identity.pricebookItemId : null,
        itemKey: byPricebook ? null : key,
        qboItemId,
        createdByClara,
      },
    });
  } catch (e) {
    logger.warn("Could not link QBO item; continuing with the id we have", {
      ...scope,
      qboItemId,
      name: key,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * The income account created items bill against. Prefers the ingested accounts, then asks
 * QuickBooks. An admin-chosen account (passed in by the caller) always wins over both — this
 * fallback exists so a company that has not chosen one still gets a working item (G10).
 */
async function firstIncomeAccountId(
  conn: QboConnection,
  companyId: number
): Promise<string | null> {
  const local = await prisma.rawQbAccount.findFirst({
    where: { companyId, active: true, accountType: "Income" },
    select: { qboId: true },
    orderBy: { name: "asc" },
  });
  if (local) return local.qboId;

  const rows = await queryAll<{ Id: string }>(conn, "Account", "AccountType = 'Income'", {
    pageSize: 1,
    maxPages: 1,
  });
  return rows[0] ? String(rows[0].Id) : null;
}

// ---------- customers: pick an existing one, or create and sync a new one ----------

/**
 * Intuit's rules for a customer, worth enforcing before we call rather than after we fail:
 *  - DisplayName must not contain a colon, tab or newline (colon is the sub-customer separator);
 *  - DisplayName must be unique across Customer, Vendor AND Employee — so a name that collides
 *    with a vendor is rejected, which no amount of customer-list checking would have predicted;
 *  - an email, if given, must contain an "@" and a "." or the whole create is rejected;
 *  - DisplayName, or one of Title/GivenName/MiddleName/FamilyName/Suffix, is required.
 * Source: Intuit Customer entity reference (~/clara/customerqbo.md).
 */
export const customerDisplayName = (name: string) =>
  name.replace(/[:\t\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface NewQboCustomer {
  name: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
}

/** What the picker and the create path both return, so callers treat them alike. */
export interface LinkedCustomer {
  customerId: number;
  name: string;
  qboId: string | null;
}

/**
 * Create a customer — in CLARA always, and in QuickBooks too when the company is connected.
 *
 * The entity comes first on purpose: a company with no accounting integration still needs
 * customers, and a QuickBooks outage must not stop someone taking down a new customer's details
 * on site. When QBO is connected the two are created together, because the estimate cannot be
 * posted until the customer exists there (product rule, 2026-09-07).
 *
 * Errors are written for a technician standing in someone's kitchen, which is where this is
 * called from. The duplicate case is the one worth naming: QuickBooks enforces DisplayName
 * uniqueness across customers, VENDORS and employees, so "already exists" can be true even when
 * the customer list looks clear.
 */
export async function createCustomer(
  companyId: number,
  input: NewQboCustomer,
  conn: QboConnection | null
): Promise<LinkedCustomer> {
  const name = customerDisplayName(input.name);
  if (!name) throw new Error("A customer name is required");

  const email = str(input.email);
  if (email && !EMAIL_OK.test(email)) throw new Error(`"${email}" is not a valid email address`);

  const existing = await prisma.customer.findUnique({
    where: { companyId_name: { companyId, name } },
    select: { id: true },
  });
  if (existing)
    throw new Error(`"${name}" is already one of your customers — pick them from the list instead`);

  const customer = await prisma.customer.create({
    data: { companyId, name, email, phone: str(input.phone), address: str(input.address) },
  });

  if (!conn?.realmId) return { customerId: customer.id, name, qboId: null };

  const qboId = await pushCustomerToQbo(conn, companyId, conn.realmId, customer.id, {
    ...input,
    name,
  });
  return { customerId: customer.id, name, qboId };
}

/**
 * Create one of our customers in QuickBooks and record the link. Split out so it can also run
 * later for a customer created while the company was disconnected.
 */
async function pushCustomerToQbo(
  conn: QboConnection,
  companyId: number,
  realmId: string,
  customerId: number,
  input: NewQboCustomer
): Promise<string> {
  const displayName = customerDisplayName(input.name);
  const email = str(input.email);
  let created: { Customer: { Id: string } };
  try {
    created = await qboFetch(conn, "/customer", {
      method: "POST",
      body: JSON.stringify({
        DisplayName: displayName,
        ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
        ...(str(input.phone) ? { PrimaryPhone: { FreeFormNumber: str(input.phone) } } : {}),
        ...(str(input.address) ? { BillAddr: { Line1: str(input.address) } } : {}),
      }),
    });
  } catch (e) {
    const body = e instanceof Error ? e.message : String(e);
    if (/6240|Duplicate Name/i.test(body))
      throw new Error(
        `"${displayName}" already exists in QuickBooks (names are shared with vendors and employees). Pick the existing customer, or use a different name.`
      );
    throw e;
  }
  const qboId = String(created.Customer.Id);
  const qb = { qboId, displayName, raw: created.Customer as object, syncedAt: new Date() };
  await prisma.customerQb.upsert({
    where: { customerId_realmId: { customerId, realmId } },
    create: { customerId, companyId, realmId, ...qb },
    update: qb,
  });
  logger.info("QBO customer created", { companyId, customerId, qboId, displayName });
  return qboId;
}

/**
 * The QuickBooks customer id an estimate bills to, guaranteed to exist before the estimate does.
 *
 * Preference order:
 *  1. the customer linked to this quote, already synced to this realm;
 *  2. that customer, not yet synced — pushed now, because the estimate cannot reference it
 *     otherwise (this is the "sync the customer, then the estimate" rule);
 *  3. no linked customer (a quote predating the picker) — adopt an exact DisplayName match in
 *     QuickBooks if there is one, so we never create a duplicate, else create.
 */
export async function ensureQboCustomer(
  conn: QboConnection,
  companyId: number,
  quote: { id: string; customerId: number | null },
  fallback: NewQboCustomer
): Promise<string> {
  const realmId = conn.realmId;
  if (!realmId) throw new Error("QuickBooks connection has no realm — reconnect from Settings");

  if (quote.customerId != null) {
    const link = await prisma.customerQb.findUnique({
      where: { customerId_realmId: { customerId: quote.customerId, realmId } },
      select: { qboId: true },
    });
    if (link) return link.qboId;

    const c = await prisma.customer.findUnique({
      where: { id: quote.customerId },
      select: { name: true, email: true, phone: true, address: true },
    });
    if (c) return pushCustomerToQbo(conn, companyId, realmId, quote.customerId, c);
  }

  // Legacy path: the quote carries only free text. Adopt rather than duplicate (US4).
  const name = customerDisplayName(fallback.name) || "Customer";
  const customer =
    (await prisma.customer.findUnique({
      where: { companyId_name: { companyId, name } },
      select: { id: true },
    })) ??
    (await prisma.customer.create({
      data: {
        companyId,
        name,
        email: str(fallback.email),
        phone: str(fallback.phone),
        address: str(fallback.address),
      },
    }));

  const link = await prisma.customerQb.findUnique({
    where: { customerId_realmId: { customerId: customer.id, realmId } },
    select: { qboId: true },
  });
  if (link) {
    await prisma.quote.update({ where: { id: quote.id }, data: { customerId: customer.id } });
    return link.qboId;
  }

  const found = await queryAll<{ Id: string }>(
    conn,
    "Customer",
    `DisplayName = '${escLiteral(name)}'`,
    { pageSize: 1, maxPages: 1 }
  );
  let qboId: string;
  if (found[0]) {
    qboId = String(found[0].Id);
    const qb = { qboId, displayName: name, raw: found[0] as object, syncedAt: new Date() };
    await prisma.customerQb.upsert({
      where: { customerId_realmId: { customerId: customer.id, realmId } },
      create: { customerId: customer.id, companyId, realmId, ...qb },
      update: qb,
    });
  } else {
    qboId = await pushCustomerToQbo(conn, companyId, realmId, customer.id, { ...fallback, name });
  }

  await prisma.quote.update({ where: { id: quote.id }, data: { customerId: customer.id } });
  return qboId;
}

/** QBO query literals escape single quotes with a backslash. */
const escLiteral = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// ---------- sales-tax settings ----------

/**
 * Add or update one of the company's sales-tax rates.
 *
 * The default is moved inside a transaction rather than with two writes: a company must never
 * be observable with two defaults, because whichever one a new estimate happened to read would
 * be arbitrary — and it would be arbitrary in money.
 */
export async function upsertSalesTax(
  companyId: number,
  input: { id: number | null; name: string; ratePercent: number; active: boolean; isDefault: boolean }
) {
  const clash = await prisma.salesTax.findUnique({
    where: { companyId_name: { companyId, name: input.name } },
    select: { id: true },
  });
  if (clash && clash.id !== input.id)
    throw new Error(`You already have a rate called "${input.name}"`);

  return prisma.$transaction(async (tx) => {
    const saved =
      input.id == null
        ? await tx.salesTax.create({
            data: {
              companyId,
              name: input.name,
              ratePercent: input.ratePercent,
              active: input.active,
              isDefault: input.isDefault,
            },
          })
        : await (async () => {
            const owned = await tx.salesTax.findFirst({
              where: { id: input.id!, companyId },
              select: { id: true },
            });
            if (!owned) throw new Error("That rate does not belong to this company");
            return tx.salesTax.update({
              where: { id: input.id! },
              data: {
                name: input.name,
                ratePercent: input.ratePercent,
                active: input.active,
                isDefault: input.isDefault,
              },
            });
          })();

    if (input.isDefault)
      await tx.salesTax.updateMany({
        where: { companyId, isDefault: true, id: { not: saved.id } },
        data: { isDefault: false },
      });
    return saved;
  });
}

/** Move (or clear) the default rate. Null means new estimates start untaxed. */
export async function setDefaultSalesTax(companyId: number, id: number | null) {
  await prisma.$transaction(async (tx) => {
    if (id != null) {
      const owned = await tx.salesTax.findFirst({
        where: { id, companyId, active: true },
        select: { id: true },
      });
      if (!owned) throw new Error("That rate does not belong to this company, or is inactive");
    }
    await tx.salesTax.updateMany({ where: { companyId, isDefault: true }, data: { isDefault: false } });
    if (id != null) await tx.salesTax.update({ where: { id }, data: { isDefault: true } });
  });
}
