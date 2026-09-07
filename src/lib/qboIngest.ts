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

// ---------- customers (US4, and the picker) ----------

interface QboCustomerRow {
  Id: string;
  DisplayName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  Active?: boolean;
}

async function ingestCustomers(conn: QboConnection, companyId: number): Promise<number> {
  const rows = await queryAll<QboCustomerRow>(conn, "Customer");
  for (const r of rows) {
    const data = {
      displayName: str(r.DisplayName) ?? `Customer ${id(r.Id)}`,
      email: str(r.PrimaryEmailAddr?.Address),
      phone: str(r.PrimaryPhone?.FreeFormNumber),
      active: r.Active !== false,
      raw: r as object,
      syncedAt: new Date(),
    };
    await prisma.rawQbCustomer.upsert({
      where: { companyId_qboId: { companyId, qboId: id(r.Id) } },
      create: { companyId, qboId: id(r.Id), ...data },
      update: data,
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

// ---------- sales tax ----------

interface QboTaxCodeRow {
  Id: string;
  Name?: string;
  Taxable?: boolean;
  Active?: boolean;
}
interface QboTaxRateRow {
  Id: string;
  Name?: string;
  RateValue?: number | string;
  Active?: boolean;
}

async function ingestTaxCodes(conn: QboConnection, companyId: number): Promise<number> {
  const rows = await queryAll<QboTaxCodeRow>(conn, "TaxCode");
  for (const r of rows) {
    const data = {
      name: str(r.Name) ?? `TaxCode ${id(r.Id)}`,
      taxable: r.Taxable !== false,
      active: r.Active !== false,
      raw: r as object,
      syncedAt: new Date(),
    };
    await prisma.rawQbTaxCode.upsert({
      where: { companyId_qboId: { companyId, qboId: id(r.Id) } },
      create: { companyId, qboId: id(r.Id), ...data },
      update: data,
    });
  }
  return rows.length;
}

async function ingestTaxRates(conn: QboConnection, companyId: number): Promise<number> {
  const rows = await queryAll<QboTaxRateRow>(conn, "TaxRate");
  for (const r of rows) {
    const rate = r.RateValue == null ? null : Number(r.RateValue);
    const data = {
      name: str(r.Name) ?? `TaxRate ${id(r.Id)}`,
      // A non-finite rate is dropped rather than stored as NaN — this value pre-fills the org
      // default, so a junk number here would become a junk tax rate on real estimates.
      rateValue: rate != null && Number.isFinite(rate) ? rate : null,
      active: r.Active !== false,
      raw: r as object,
      syncedAt: new Date(),
    };
    await prisma.rawQbTaxRate.upsert({
      where: { companyId_qboId: { companyId, qboId: id(r.Id) } },
      create: { companyId, qboId: id(r.Id), ...data },
      update: data,
    });
  }
  return rows.length;
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

  const counts: IngestCounts = {
    customers: await ingestCustomers(conn, companyId),
    items: await ingestItems(conn, companyId),
    taxCodes: await ingestTaxCodes(conn, companyId),
    taxRates: await ingestTaxRates(conn, companyId),
    accounts: await ingestAccounts(conn, companyId),
  };
  logger.info("QBO reference data synced", { companyId, ...counts });
  return counts;
}

// ---------- reads for the UI ----------

/**
 * Customer typeahead. Empty query returns the first page so the picker has something to show
 * before anyone types. Inactive customers are excluded: they cannot be billed.
 */
export function searchQboCustomers(companyId: number, q: string, limit = 20) {
  const term = q.trim();
  return prisma.rawQbCustomer.findMany({
    where: {
      companyId,
      active: true,
      ...(term ? { displayName: { contains: term, mode: "insensitive" as const } } : {}),
    },
    select: { qboId: true, displayName: true, email: true, phone: true },
    orderBy: { displayName: "asc" },
    take: Math.min(limit, 50),
  });
}

/** Income accounts, for the admin to choose what created items bill against (G10). */
export function qboIncomeAccounts(companyId: number) {
  return prisma.rawQbAccount.findMany({
    where: { companyId, active: true, accountType: "Income" },
    select: { qboId: true, name: true, accountSubType: true },
    orderBy: { name: "asc" },
  });
}

/** Tax rates, to pre-fill the organisation's default rate rather than have an admin type it. */
export function qboTaxRateOptions(companyId: number) {
  return prisma.rawQbTaxRate.findMany({
    where: { companyId, active: true, rateValue: { not: null } },
    select: { qboId: true, name: true, rateValue: true },
    orderBy: { name: "asc" },
  });
}

/** When the company last synced, so the UI can offer a refresh instead of guessing. */
export async function qboSyncedAt(companyId: number): Promise<Date | null> {
  const newest = await prisma.rawQbCustomer.findFirst({
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

/** What the picker and the create path both return, so the caller treats them alike. */
export interface LinkedQboCustomer {
  qboId: string;
  displayName: string;
}

/**
 * Create a customer in QuickBooks and mirror it locally.
 *
 * Thrown errors carry a message meant for a technician standing in someone's kitchen, because
 * that is where this gets called from. The duplicate case is the one worth naming: QuickBooks
 * enforces DisplayName uniqueness across customers, vendors and employees, so "already exists"
 * can be true even when the customer list looks clear.
 */
export async function createQboCustomer(
  conn: QboConnection,
  companyId: number,
  input: NewQboCustomer
): Promise<LinkedQboCustomer> {
  const displayName = customerDisplayName(input.name);
  if (!displayName) throw new Error("A customer name is required");

  const email = str(input.email);
  if (email && !EMAIL_OK.test(email))
    throw new Error(`"${email}" is not a valid email address`);

  let created: { Customer: { Id: string; DisplayName?: string } };
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
    // QBO fault 6240 / "Duplicate Name Exists Error" — the name is taken by a customer, vendor
    // or employee. Say which name, since the UI cannot know why an unused-looking name failed.
    if (/6240|Duplicate Name/i.test(body))
      throw new Error(
        `"${displayName}" already exists in QuickBooks (names are shared with vendors and employees). Pick the existing customer, or use a different name.`
      );
    throw e;
  }

  const qboId = String(created.Customer.Id);
  await mirrorCustomer(companyId, qboId, displayName, input, created.Customer);
  logger.info("QBO customer created", { companyId, qboId, displayName });
  return { qboId, displayName };
}

/** Write a customer into the mirror so the picker sees it without waiting for a full re-sync. */
async function mirrorCustomer(
  companyId: number,
  qboId: string,
  displayName: string,
  input: NewQboCustomer,
  raw: object
) {
  const data = {
    displayName,
    email: str(input.email),
    phone: str(input.phone),
    active: true,
    raw,
    syncedAt: new Date(),
  };
  try {
    await prisma.rawQbCustomer.upsert({
      where: { companyId_qboId: { companyId, qboId } },
      create: { companyId, qboId, ...data },
      update: data,
    });
  } catch (e) {
    // The id is already in hand; a mirror miss costs a picker refresh, not the estimate.
    logger.warn("Could not mirror QBO customer", {
      companyId,
      qboId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * The customer an estimate bills to, guaranteed to exist in QuickBooks before the estimate does.
 *
 * Preference order:
 *  1. the customer explicitly linked to this quote — what the estimate screen's picker sets;
 *  2. an exact DisplayName match, from the mirror first and then live, so we adopt rather than
 *     duplicate (US4: never a second record, never a suffix, never an overwrite);
 *  3. create one from the quote's own customer details.
 *
 * Whichever path runs, the id is written back to the quote, so re-completing later reuses it
 * instead of matching by name again.
 */
export async function ensureQboCustomer(
  conn: QboConnection,
  companyId: number,
  quote: { id: string; qboCustomerId: string | null },
  fallback: NewQboCustomer
): Promise<string> {
  if (quote.qboCustomerId) return quote.qboCustomerId;

  const displayName = customerDisplayName(fallback.name) || "Customer";

  const mirrored = await prisma.rawQbCustomer.findFirst({
    where: { companyId, displayName, active: true },
    select: { qboId: true, displayName: true },
  });
  let linked: LinkedQboCustomer | null = mirrored
    ? { qboId: mirrored.qboId, displayName: mirrored.displayName }
    : null;

  if (!linked) {
    const found = await queryAll<{ Id: string; DisplayName?: string }>(
      conn,
      "Customer",
      `DisplayName = '${escLiteral(displayName)}'`,
      { pageSize: 1, maxPages: 1 }
    );
    if (found[0]) {
      linked = { qboId: String(found[0].Id), displayName };
      await mirrorCustomer(companyId, linked.qboId, displayName, fallback, found[0]);
    }
  }

  if (!linked) linked = await createQboCustomer(conn, companyId, { ...fallback, name: displayName });

  await linkCustomerToQuote(quote.id, linked);
  return linked.qboId;
}

/** Record the choice on the quote. The estimate payload reads it; the UI displays the name. */
export async function linkCustomerToQuote(quoteId: string, customer: LinkedQboCustomer) {
  await prisma.quote.update({
    where: { id: quoteId },
    data: { qboCustomerId: customer.qboId, qboCustomerName: customer.displayName },
  });
}

/** QBO query literals escape single quotes with a backslash. */
const escLiteral = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
