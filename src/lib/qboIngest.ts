import type { QboConnection } from "@prisma/client";
import { Prisma } from "@prisma/client";
import prisma from "./prisma";
import logger from "./logger";
import { queryAll, qboFetch, qboConnectionFor, qboConnected } from "./qbo";
import { parseAddress, toBillAddr, fromBillAddr } from "./addressParse";
import { UserFacingError } from "./clientError";

/**
 * Postgres 23505 — the row is already there. Narrow on purpose: it is the ONE database error
 * that means "someone else got here first", and every other one has to keep propagating.
 */
const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

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
  /** Read-only, parent chain joined by colons: "Customer:Job:Sub-job". */
  FullyQualifiedName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  BillAddr?: {
    Line1?: string;
    Line2?: string;
    /** QuickBooks allows five address lines; 3-5 are collapsed into line2 on ingest. */
    Line3?: string;
    Line4?: string;
    Line5?: string;
    City?: string;
    CountrySubDivisionCode?: string;
    PostalCode?: string;
    Country?: string;
  };
  /** Set on a sub-customer (a Job); its value is the parent's QuickBooks id. */
  ParentRef?: { value?: string };
  Job?: boolean;
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
    // QuickBooks already holds the address in components, so this path never calls the LLM —
    // there is nothing to infer, only to copy across (T-65).
    const addr = fromBillAddr(r.BillAddr);
    const address = addr.address ?? addrLine(r.BillAddr);

    const linked = await prisma.customerQb.findUnique({
      where: { companyId_realmId_qboId: { companyId, realmId, qboId } },
      select: { customerId: true },
    });
    // The name fallback exists to adopt a customer CLARA created locally before it synced. Now
    // that names repeat across parents, a name alone can match more than one row — and adopting
    // the wrong one re-points every quote that bills it. So it adopts only when the match is
    // UNAMBIGUOUS; two candidates means create a fresh row and let pass 2 sort out the parent.
    const nameMatches = linked
      ? []
      : await prisma.customer.findMany({
          where: { companyId, name: displayName, isDeleted: false },
          select: { id: true },
          take: 2,
        });
    if (nameMatches.length > 1)
      logger.info("QBO customer name matches more than one local customer; not adopting", {
        companyId,
        name: displayName,
        qboId,
      });
    const byName = nameMatches.length === 1 ? nameMatches[0] : null;

    // The name fallback may adopt a customer that is ALREADY linked to a different QuickBooks
    // customer in this realm — rename "Acme" to "Acme LLC" there, create a new "Acme", and the
    // name match lands on the old row. Overwriting its qboId would silently re-point every
    // quote that bills it at a different party, so a taken row is refused and a fresh customer
    // is created for the incoming id instead.
    let adopt = byName?.id ?? null;
    if (adopt != null) {
      const taken = await prisma.customerQb.findUnique({
        where: { customerId_realmId: { customerId: adopt, realmId } },
        select: { qboId: true },
      });
      if (taken && taken.qboId !== qboId) {
        logger.warn("QBO customer name matches a customer already linked elsewhere", {
          companyId,
          name: displayName,
          incomingQboId: qboId,
          linkedQboId: taken.qboId,
        });
        adopt = null;
      }
    }

    const customerId =
      linked?.customerId ??
      adopt ??
      (
        await prisma.customer.create({
          data: {
            companyId,
            // Suffixed when the plain name is taken by a differently-linked customer at the
            // SAME level: the (company, parent, name) unique would otherwise reject the row and
            // abort the sync. Parents are linked in pass 2, so at this point every new row is
            // still parent-less and a same-name sibling is a real collision.
            name: adopt === null && nameMatches.length > 0 ? `${displayName} (${qboId})` : displayName,
            email,
            phone,
            address,
            addressLine1: addr.addressLine1,
            addressLine2: addr.addressLine2,
            city: addr.city,
            state: addr.state,
            postalCode: addr.postalCode,
            country: addr.country,
            isActive: r.Active !== false,
          },
        })
      ).id;

    // Fill gaps only — never clobber what someone typed here.
    const current = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { email: true, phone: true, address: true, addressLine1: true },
    });
    await prisma.customer.update({
      where: { id: customerId },
      data: {
        email: current?.email ?? email,
        phone: current?.phone ?? phone,
        address: current?.address ?? address,
        // The structured columns fill as a set, keyed off line1: filling them field-by-field
        // could splice a QuickBooks city onto a locally-typed street and produce an address
        // that exists in neither system.
        ...(current?.addressLine1
          ? {}
          : {
              addressLine1: addr.addressLine1,
              addressLine2: addr.addressLine2,
              city: addr.city,
              state: addr.state,
              postalCode: addr.postalCode,
              country: addr.country,
            }),
        // Refreshed every sync, unlike the contact fields: a customer deactivated in QuickBooks
        // must stop being offered here, or a technician links an estimate that QBO then rejects.
        isActive: r.Active !== false,
      },
    });

    const qb = {
      qboId,
      displayName,
      fullyQualifiedName: str(r.FullyQualifiedName),
      raw: r as object,
      syncedAt: new Date(),
    };
    await prisma.customerQb.upsert({
      where: { customerId_realmId: { customerId, realmId } },
      create: { customerId, companyId, realmId, ...qb },
      update: qb,
    });
  }

  await linkParents(companyId, realmId, rows);

  // Customers QuickBooks no longer returns — deleted there, or deactivated — are deactivated
  // here too (T-46). Without this the mirror only ever grows: the picker keeps offering someone
  // who is gone from the books, and the estimate that bills them is rejected at post time, long
  // after the technician chose them.
  //
  // Scoped to rows that came FROM this realm: a customer created in CLARA for a company with no
  // QuickBooks connection has no link and must never be touched by a QuickBooks sync. Safe to
  // run unconditionally now that `queryAll` throws rather than returning a truncated page — a
  // partial read cannot reach this line and mass-deactivate a live customer list.
  const seenIds = rows.map((r) => id(r.Id));
  const stale = await prisma.customer.updateMany({
    where: {
      companyId,
      isActive: true,
      qb: { some: { realmId, qboId: { notIn: seenIds } } },
    },
    data: { isActive: false },
  });
  if (stale.count > 0)
    logger.info("QBO customers no longer present were deactivated", {
      companyId,
      realmId,
      count: stale.count,
    });

  return rows.length;
}

/**
 * Second pass: hang each sub-customer under its parent (T-64).
 *
 * Separate from the first pass because the query can return a child BEFORE its parent, and a
 * parent that has not been inserted yet has no local id to point at. Doing it afterwards means
 * every row exists, so one map resolves the whole hierarchy however deep it goes — QuickBooks
 * allows five levels — with no recursion and no ordering assumption.
 */
async function linkParents(companyId: number, realmId: string, rows: QboCustomerRow[]) {
  const withParent = rows.filter((r) => str(r.ParentRef?.value));
  if (!withParent.length) return;

  const links = await prisma.customerQb.findMany({
    where: { companyId, realmId, isDeleted: false },
    select: { customerId: true, qboId: true },
  });
  const localIdOf = new Map(links.map((l) => [l.qboId, l.customerId]));

  let unresolved = 0;
  // Assignment is UNCONDITIONAL and covers every ingested row, not just the ones with a parent:
  // QuickBooks owns this hierarchy (it computes FullyQualifiedName and enforces the depth cap),
  // so a job moved to the top level there must lose its parent here. Linking only ever forward
  // would leave the mirror permanently claiming a parent QuickBooks has dropped.
  for (const r of rows) {
    const childId = localIdOf.get(id(r.Id));
    if (childId == null) continue;
    const parentRef = str(r.ParentRef?.value);
    const parentId = parentRef ? (localIdOf.get(parentRef) ?? null) : null;
    if (parentRef && parentId == null) {
      unresolved++;
      // Do not null the existing link on a parent we simply could not see this pass — that
      // would drop a real hierarchy because of a partial read.
      continue;
    }
    // A row cannot be its own parent. QuickBooks should never send this, but the column is
    // self-referential and a cycle here would make any later hierarchy walk non-terminating.
    if (childId === parentId) continue;
    await prisma.customer.update({ where: { id: childId }, data: { parentId } });

    // Heal the suffix pass 1 had to add. Two jobs called "Building 1" under different properties
    // both arrive parent-less, so the second collides on (company, NULL, name) and is stored as
    // "Building 1 (62)". Once the parent is known that collision is gone — and without this the
    // suffix would stick forever, because every later sync matches on qboId and never revisits
    // the name. Best-effort: a name still taken under the new parent simply keeps its suffix.
    const suffix = new RegExp(` \\(${id(r.Id)}\\)$`);
    const row = await prisma.customer.findUnique({ where: { id: childId }, select: { name: true } });
    if (row && suffix.test(row.name)) {
      const plain = row.name.replace(suffix, "");
      const clash = await prisma.customer.findFirst({
        where: { companyId, parentId, name: plain, id: { not: childId }, isDeleted: false },
        select: { id: true },
      });
      if (!clash) {
        await prisma.customer.update({ where: { id: childId }, data: { name: plain } });
        logger.info("Dropped the disambiguating suffix once the parent was known", {
          companyId,
          customerId: childId,
          name: plain,
        });
      }
    }
  }
  logger.info("Linked QBO sub-customers to their parents", {
    companyId,
    realmId,
    children: withParent.length,
    unresolved,
  });
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

  // Items deleted in QuickBooks stop being returned rather than coming back inactive, so the
  // mirror has to be told (T-46). It matters more here than it looks: the registry resolves a
  // line to a stored item id, and an id that no longer exists makes the whole estimate post
  // fail with a reference error naming a part nobody recognises.
  const gone = await prisma.rawQbItem.updateMany({
    where: { companyId, active: true, qboId: { notIn: rows.map((r) => id(r.Id)) } },
    data: { active: false },
  });
  if (gone.count > 0)
    logger.info("QBO items no longer present were deactivated", { companyId, count: gone.count });

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
): number | null {
  let effective = 0;
  const ordered = [...details].sort((a, b) => (a.TaxOrder ?? 0) - (b.TaxOrder ?? 0));
  for (const d of ordered) {
    const value = rateById.get(String(d.TaxRateRef?.value ?? ""));
    // A member we cannot resolve makes the whole cascade wrong, and wrong in the direction of
    // charging too little. Returning null refuses the code; skipping the member would have
    // produced a plausible number nobody could tell from the truth — dropping AZ State from
    // "Tucson" reads as 2.0000% instead of 9.1%.
    if (value == null || !Number.isFinite(value)) return null;
    effective +=
      d.TaxTypeApplicable === "TaxOnAmountPlusTax" ? value * (1 + effective / 100) : value;
  }
  // Four decimals: the column is Decimal(6,4), and real rates use them (9.0625%).
  const rounded = Math.round(effective * 10000) / 10000;
  // Outside the column's range this would throw mid-loop and abort the whole sync, so refuse
  // the one code instead.
  return rounded < 0 || rounded > 99.9999 ? null : rounded;
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
  const seen: number[] = [];
  const skipped: string[] = [];

  for (const c of codes) {
    if (c.Active === false || c.Taxable === false) continue;
    // Driven off the member list rather than the TaxGroup flag: a code with rates is importable
    // whatever the flag says, and a code without them has no percentage of its own (the pseudo
    // codes TAX and NON, and empty groups like the sandbox's "CustomSalesTax").
    const details = c.SalesTaxRateList?.TaxRateDetail ?? [];
    if (details.length === 0) continue;

    const effective = taxGroupEffectiveRate(details, rateById);
    if (effective == null) {
      // Logged by name, because a silently missing rate is the failure mode that costs money.
      skipped.push(str(c.Name) ?? id(c.Id));
      continue;
    }
    const name = str(c.Name) ?? `TaxCode ${id(c.Id)}`;

    // Match on the QBO id FIRST, via the link. Matching on name alone meant a code renamed in
    // QuickBooks created a second row while the old one kept its percentage, its isActive and
    // its isDefault — so the company quoted a stale rate forever.
    const linked = await prisma.salesTaxQb.findFirst({
      where: { companyId, realmId, qboType: "TaxCode", qboId: id(c.Id) },
      select: { salesTaxId: true },
    });
    const byName = linked
      ? null
      : await prisma.salesTax.findFirst({
          // source: "QBO" only. Adopting a MANUAL row of the same name would rewrite an admin's
          // hand-typed percentage with QuickBooks' number and flip its provenance — and if that
          // row was the default, the ingested rate would inherit isDefault, breaking the rule
          // that ingested rates arrive as candidates and never as the default.
          where: { companyId, name, source: "QBO", isDeleted: false },
          select: { id: true },
        });

    const salesTaxId =
      linked?.salesTaxId ??
      byName?.id ??
      (
        await prisma.salesTax.create({
          data: { companyId, name, source: "QBO", ratePercent: effective },
        })
      ).id;

    await prisma.salesTax.update({
      where: { id: salesTaxId },
      // The name follows QuickBooks when the code is renamed there — it is the same rate.
      // isActive is deliberately NOT forced true: an admin who deactivated a rate should not
      // have it silently reactivated by the next sync.
      data: { name, source: "QBO", ratePercent: effective, isDeleted: false },
    });
    seen.push(salesTaxId);

    const codeQb = { salesTaxId, name, raw: c as object, syncedAt: new Date() };
    await prisma.salesTaxQb.upsert({
      where: {
        salesTaxId_companyId_realmId_qboType_qboId: {
          salesTaxId,
          companyId,
          realmId,
          qboType: "TaxCode",
          qboId: id(c.Id),
        },
      },
      create: { companyId, realmId, qboType: "TaxCode", qboId: id(c.Id), ...codeQb },
      update: codeQb,
    });

    // The members, so the breakdown behind the number stays recoverable. Keyed per sales-tax
    // row: one QuickBooks rate belongs to many groups (a state rate sits in every city group),
    // so a key without salesTaxId would move the row and leave the other group's breakdown
    // claiming a total it cannot add up to.
    for (const d of details) {
      const rid = String(d.TaxRateRef?.value ?? "");
      if (!rateById.has(rid)) continue;
      const rateQb = { name: rateNameById.get(rid) ?? rid, raw: d as object, syncedAt: new Date() };
      await prisma.salesTaxQb.upsert({
        where: {
          salesTaxId_companyId_realmId_qboType_qboId: {
            salesTaxId,
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

  // Codes that no longer come back from QuickBooks — deleted, deactivated, or newly
  // non-taxable — are deactivated here and lose the default. Without this a company keeps
  // quoting a rate that no longer exists in their books, and settings still shows it as the
  // default. Only ever runs on a complete pass: a truncated read would deactivate live rates.
  if (imported > 0 && skipped.length === 0) {
    const stale = await prisma.salesTax.updateMany({
      where: { companyId, source: "QBO", isActive: true, id: { notIn: seen } },
      data: { isActive: false, isDefault: false },
    });
    if (stale.count > 0) {
      // The mirror rows go with it. Left active, `qboTaxCodeRef` would keep resolving a TaxCode
      // Intuit has retired, and the post would fail on a code the settings screen already shows
      // as inactive — the two mirrors disagreeing about the same rate.
      await prisma.salesTaxQb.updateMany({
        where: { companyId, realmId, salesTaxId: { notIn: seen } },
        data: { isActive: false },
      });
      logger.info("QBO tax codes no longer present were deactivated", {
        companyId,
        count: stale.count,
      });
    }
  }
  if (skipped.length > 0)
    logger.warn("QBO tax codes skipped — a member rate could not be resolved", {
      companyId,
      codes: skipped,
    });

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
/**
 * How long a sync may hold its claim before another run may take it (T-44). A task killed
 * mid-sync cannot release its own claim, so without an expiry the company could never sync
 * again; ten minutes is far longer than the observed run (about four seconds for 39 customers,
 * 43 items and 90 accounts) and far shorter than a person's patience.
 */
const SYNC_CLAIM_STALE_MS = 10 * 60 * 1000;

export async function syncQboReferenceData(companyId: number): Promise<IngestCounts> {
  const conn = await qboConnectionFor(companyId);
  if (!qboConnected(conn))
    throw new UserFacingError("QuickBooks is not connected for this company");
  const realmId = conn.realmId;
  if (!realmId) throw new UserFacingError("QuickBooks connection has no realm — reconnect from Settings");

  // One sync per company at a time (T-44). A sync takes long enough to invite a second click,
  // and two concurrent runs race the same upserts *and* the unserialised token refresh — the
  // second refresh invalidates the first's refresh token and both runs die holding a connection
  // that now needs reconnecting.
  //
  // The claim is a conditional UPDATE, and the row count is the answer. Deliberately not a
  // `pg_try_advisory_lock`: session-scoped advisory locks are re-entrant, so two runs sharing a
  // pooled connection would both "acquire" it and the first unlock would free it for both.
  const claim = await prisma.qboConnection.updateMany({
    where: {
      companyId,
      OR: [
        { syncStartedAt: null },
        { syncStartedAt: { lt: new Date(Date.now() - SYNC_CLAIM_STALE_MS) } },
      ],
    },
    data: { syncStartedAt: new Date() },
  });
  if (claim.count === 0)
    throw new UserFacingError("A QuickBooks sync is already running for this company");

  // Each stage is attempted even when an earlier one failed: the stages are independent mirrors,
  // upserts are idempotent, and refusing to ingest tax because items timed out helps nobody.
  // What must NOT happen is the run then counting as fresh (T-45).
  const counts: IngestCounts = { customers: 0, items: 0, accounts: 0, taxCodes: 0, taxRates: 0 };
  const failures: string[] = [];
  const stage = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (e) {
      failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      logger.error("QBO sync stage failed", { companyId, realmId, stage: name, error: e });
    }
  };

  try {
    await stage("taxPrefs", async () => {
      await ingestTaxPrefs(conn, companyId);
    });
    await stage("customers", async () => {
      counts.customers = await ingestCustomers(conn, companyId, realmId);
    });
    await stage("items", async () => {
      counts.items = await ingestItems(conn, companyId);
    });
    await stage("salesTax", async () => {
      Object.assign(counts, await ingestSalesTax(conn, companyId, realmId));
    });
    await stage("accounts", async () => {
      counts.accounts = await ingestAccounts(conn, companyId);
    });

    if (failures.length) {
      // Record the failure and keep whatever did land. `lastSyncAt` is deliberately NOT advanced:
      // "last synced" must mean "last complete sync", or it is a claim the mirrors cannot back.
      await prisma.qboConnection.update({
        where: { companyId },
        data: { lastSyncError: failures.join("; ").slice(0, 1000) },
      });
      throw new Error(`QuickBooks sync incomplete — ${failures.join("; ")}`);
    }

    await prisma.qboConnection.update({
      where: { companyId },
      data: { lastSyncAt: new Date(), lastSyncError: null },
    });
    logger.info("QBO reference data synced", { companyId, realmId, ...counts });
    return counts;
  } finally {
    // Released whatever happened — a failed sync must not block the retry it is asking for.
    await prisma.qboConnection
      .update({ where: { companyId }, data: { syncStartedAt: null } })
      .catch((e) =>
        logger.error("Could not release the QuickBooks sync claim", {
          companyId,
          error: e instanceof Error ? e.message : String(e),
        })
      );
  }
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
export async function searchCustomers(
  companyId: number,
  q: string,
  limit = 20,
  /** The company's currently connected realm; null when disconnected. */
  realmId: string | null = null
) {
  const term = q.trim();
  const rows = await prisma.customer.findMany({
    where: {
      companyId,
      isActive: true,
      isDeleted: false,
      // Matched against the qualified name too, so typing a property's name surfaces the jobs
      // under it. A leaf-only match hid every sub-customer behind a name nobody searches for.
      ...(term
        ? {
            OR: [
              { name: { contains: term, mode: "insensitive" as const } },
              {
                qb: {
                  some: {
                    ...(realmId ? { realmId } : {}),
                    fullyQualifiedName: { contains: term, mode: "insensitive" as const },
                  },
                },
              },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      // Scoped to the CURRENT realm. customer_qb holds a row per realm by design, and an
      // unscoped `take: 1` could hand back an id from a QuickBooks file the company left —
      // an id that means nothing in the connected books, presented as "synced".
      qb: realmId
        ? {
            where: { realmId },
            select: { qboId: true, fullyQualifiedName: true },
            take: 1,
          }
        : false,
    },
    orderBy: { name: "asc" },
    take: Math.min(limit, 50),
  });
  return rows.map(({ qb, ...c }) => ({
    ...c,
    qboId: qb?.[0]?.qboId ?? null,
    // Only worth showing when it says more than the name already does — for a top-level
    // customer QuickBooks sets it equal to DisplayName, and repeating it would be noise.
    fullyQualifiedName:
      qb?.[0]?.fullyQualifiedName && qb[0].fullyQualifiedName !== c.name
        ? qb[0].fullyQualifiedName
        : null,
  }));
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
 * Whether this company's tax comes from a connected system rather than from what they type.
 *
 * The rule (product, 2026-09-08): a company connected to QuickBooks takes its tax from
 * QuickBooks. It cannot create MANUAL rates, and rates it created BEFORE connecting stop being
 * applied — kept, not deleted, so disconnecting restores them.
 *
 * QuickBooks ONLY, deliberately (product, 2026-09-08). An earlier draft also treated a
 * `crm_connections` row as external, which locked ServiceTitan companies out of tax entirely:
 * they could not create a rate, and nothing ingests tax from a CRM, so they would have had none
 * at all. CRMs are out of scope for this work — when a CRM tax importer exists, add it here.
 */
export async function taxSourceIsExternal(companyId: number): Promise<{
  external: boolean;
  via: "quickbooks" | null;
}> {
  const conn = await qboConnectionFor(companyId);
  return qboConnected(conn) ? { external: true, via: "quickbooks" } : { external: false, via: null };
}

/**
 * Whether sales tax applies to this company at all.
 *
 * Two inputs, and an integration wins. The stored flag defaults OFF, because most companies do
 * not charge sales tax and a rate that starts applying itself as soon as one is configured is a
 * surprise measured in money. A company with **either** a QuickBooks connection **or** a CRM
 * connection is FORCED ON: both mean this company invoices through a system that charges tax, and
 * an estimate that declared none would disagree with what that system bills for the same job.
 *
 * **Forcing tax on is NOT the same as making that system the tax SOURCE, and the difference is
 * load-bearing.** `taxSourceIsExternal` stays QuickBooks-only on purpose: it decides whether the
 * company may create its own MANUAL rates, and an earlier draft that also treated a
 * `crm_connections` row as external locked ServiceTitan companies out of tax completely — they
 * could not create a rate, and nothing ingests tax from a CRM, so they ended up with none at all.
 * A CRM company must charge tax AND must type its own rates. Those two facts live in two
 * functions, and merging them re-creates that hole.
 *
 * `enforcedBy` names which integration is doing it, so the refusal and the settings screen can
 * say the true reason rather than blaming QuickBooks for a CRM.
 *
 * Deliberately NOT the same question as "is a default rate set". Off means this company does not
 * charge tax; no default means they do but have not said which rate. The first is a decision, the
 * second is an unfinished setup, and collapsing them loses the ability to tell a configured
 * company from an untaxed one.
 */
export async function taxEnabledFor(companyId: number): Promise<{
  enabled: boolean;
  stored: boolean;
  enforced: boolean;
  enforcedBy: "quickbooks" | "crm" | null;
}> {
  const [config, { external }, crm] = await Promise.all([
    prisma.company_configs.findUnique({
      where: { company_id: companyId },
      select: { tax_enabled: true },
    }),
    taxSourceIsExternal(companyId),
    // Read, not joined into taxSourceIsExternal — see the note above about why the CRM forces tax
    // on without owning the rates.
    prisma.crm_connections.findUnique({
      where: { company_id: companyId },
      select: { provider: true },
    }),
  ]);
  const stored = config?.tax_enabled ?? false;
  const enforcedBy = external ? "quickbooks" : crm ? "crm" : null;
  return { enabled: stored || enforcedBy != null, stored, enforced: enforcedBy != null, enforcedBy };
}

/**
 * Whether a rate can actually be applied right now.
 *
 * Exported and pure so the source-of-truth rule is testable. It was inline once, and the
 * consequence was a P0: ingestion forgot to set `source`, every synced rate defaulted to MANUAL,
 * and a connected company ended up with no usable rate and no way to create one — silently,
 * because each half of the rule looked correct on its own.
 */
export const salesTaxUsable = (
  rate: { isActive: boolean; isDeleted?: boolean; source: string },
  external: boolean
): boolean => rate.isActive && !rate.isDeleted && (!external || rate.source !== "MANUAL");

/**
 * The company's sales-tax rates. Readable by every role: an estimate has to show the rate it is
 * applying, and gating this would blank the totals for technicians.
 *
 * `usable` is computed, not stored, so it can never go stale against the connection state: a
 * MANUAL rate is unusable while the company is connected to an external system, and becomes
 * usable again the moment it disconnects. Unusable rates are still returned — the settings
 * screen has to explain why they are there rather than silently dropping them.
 */
export async function listSalesTax(companyId: number) {
  const { external, via } = await taxSourceIsExternal(companyId);
  const rows = await prisma.salesTax.findMany({
    where: { companyId, isDeleted: false },
    select: {
      id: true,
      name: true,
      source: true,
      ratePercent: true,
      isDefault: true,
      isActive: true,
      qb: { select: { qboType: true, qboId: true }, orderBy: { qboType: "asc" } },
    },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });
  const tax = await taxEnabledFor(companyId);
  return {
    taxSource: external ? via : "manual",
    taxEnabled: tax.enabled,
    /** True when a connection forces it on, so the screen can lock the switch and say why. */
    taxEnforced: tax.enforced,
    /** Which integration is forcing it — so the reason names the right one. */
    taxEnforcedBy: tax.enforcedBy,
    rates: rows.map((r) => ({
      ...r,
      usable: salesTaxUsable(r, external),
    })),
  };
}

/**
 * The rate a new estimate starts with, or null when the company has not chosen a usable one.
 *
 * Applies the same source-of-truth rule as the settings screen: a MANUAL default is ignored
 * while the company is connected to an external system. Silently taxing estimates from a rate
 * the settings screen shows as unusable would be the worst of both.
 */
export async function defaultSalesTax(companyId: number) {
  // Tax off means no snapshot, which is the whole effect of the switch. Both callers come through
  // here — quote creation and completion's gap-fill — so gating it once covers the pair, and a
  // company that turns tax off does not silently keep taxing the estimates it makes afterwards.
  // Estimates that already carry a rate keep it: the snapshot is theirs, and re-pricing a sent
  // document is exactly what the snapshot exists to prevent.
  const { enabled } = await taxEnabledFor(companyId);
  if (!enabled) return null;
  const { external } = await taxSourceIsExternal(companyId);
  return prisma.salesTax.findFirst({
    where: {
      companyId,
      isDefault: true,
      isActive: true,
      isDeleted: false,
      ...(external ? { source: { not: "MANUAL" } } : {}),
    },
    select: { id: true, name: true, ratePercent: true },
  });
}

/** When reference data was last pulled, so the UI can offer a refresh instead of guessing. */
/**
 * When this company last completed a FULL reference sync — every stage succeeding (T-45).
 *
 * Previously the newest `customer_qb.synced_at`, which meant a run that ingested 39 customers
 * and then failed on tax reported itself as freshly synced while the tax mirror was hours stale.
 */
export async function qboSyncedAt(companyId: number): Promise<Date | null> {
  const conn = await prisma.qboConnection.findUnique({
    where: { companyId },
    select: { lastSyncAt: true },
  });
  return conn?.lastSyncAt ?? null;
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
  if (!realmId) throw new UserFacingError("QuickBooks connection has no realm — reconnect from Settings");
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
    // Bounded existence probe — one row answers it.
    { pageSize: 1, maxPages: 1, expectAll: false }
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
    // Only the unique violation is benign — it means a concurrent sync linked the same item
    // first, and the row we wanted already exists with the same id. Everything else (a bad FK,
    // a dropped column, a connection failure) was being swallowed too, so the registry silently
    // stopped recording links and every later estimate re-resolved the item from scratch (T-50).
    if (!isUniqueViolation(e)) throw e;
    logger.info("QBO item already linked by a concurrent sync; reusing it", {
      ...scope,
      qboItemId,
      name: key,
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
    // Bounded: any one Income account will do.
    pageSize: 1,
    maxPages: 1,
    expectAll: false,
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
  // Trim AFTER the slice as well: cutting at 100 can re-expose whitespace the first trim
  // removed, and a trailing space changes the name QuickBooks stores — which then misses our
  // (company, name) lookup on the next sync and creates the duplicate this path exists to avoid.
  name.replace(/[:\t\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100).trim();

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parse a tax percentage from request input. Returns null for anything that is not a rate.
 *
 * Extracted from the controller because `Number(x)` says 0 for null, "" and [] — so a body with
 * `ratePercent: null` silently created a 0% rate. That matters beyond tidiness: "no rate
 * configured" and "a deliberate 0% jurisdiction" are different states, and the difference decides
 * whether tax is declared to QuickBooks at all. 0 itself is accepted; absent is not.
 */
export function parseRatePercent(raw: unknown): number | null {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string") {
    // A number read off a form: tolerate a typed "%" and surrounding space. A comma is treated
    // as a DECIMAL SEPARATOR, not stripped — deleting it turned "8,5" into 85, a ten-fold tax
    // rate that passed every bound check and reached customer money.
    const cleaned = raw.replace(/[%\s]/g, "").replace(",", ".");
    if (!cleaned) return null;
    n = Number(cleaned);
  } else return null;
  if (!Number.isFinite(n) || n < 0 || n > 99.9999) return null;
  // Decimal(6,4) — round rather than reject, so 8.250001 from a slider is not an error.
  return Math.round(n * 10000) / 10000;
}

export interface NewQboCustomer {
  name: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  /**
   * Make this a sub-customer of an existing one (T-64) — QuickBooks calls the child a Job. The
   * parent must already exist in the connected QuickBooks file: a child cannot be created before
   * its parent has an id there, the same ordering rule as customer-before-estimate.
   */
  parentId?: number | null;
}

/**
 * How this QuickBooks company calculates tax, recorded on the connection (T-63).
 *
 * Read every sync rather than once at connect: an admin can switch a company to Automated Sales
 * Tax at any time, and the switch silently changes whether the tax code CLARA sends means
 * anything. A stale "manual" would keep posting codes Intuit discards while the estimate CLARA
 * printed says otherwise.
 */
async function ingestTaxPrefs(conn: QboConnection, companyId: number) {
  const prefs = await qboFetch(conn, "/preferences");
  const tp = (prefs?.Preferences?.TaxPrefs ?? {}) as {
    UsingSalesTax?: boolean;
    PartnerTaxEnabled?: boolean;
  };
  await prisma.qboConnection.update({
    where: { companyId },
    data: {
      usingSalesTax: tp.UsingSalesTax ?? null,
      partnerTaxEnabled: tp.PartnerTaxEnabled ?? null,
    },
  });
  logger.info("QBO tax preferences read", {
    companyId,
    usingSalesTax: tp.UsingSalesTax ?? null,
    partnerTaxEnabled: tp.PartnerTaxEnabled ?? null,
  });
}

/**
 * The parent a new sub-customer will hang under, or null when it is a root customer (T-64).
 *
 * Refuses a parent that QuickBooks does not know about in the CONNECTED realm. QuickBooks needs
 * a `ParentRef` id at creation time, so a parent that has never synced cannot have a child — and
 * failing here, naming the parent, beats failing inside Intuit's API with a reference error the
 * technician cannot act on. Same ordering rule as customer-before-estimate.
 */
async function resolveParent(
  companyId: number,
  parentId: number | null,
  conn: QboConnection | null
): Promise<{ customerId: number; qboId: string | null } | null> {
  if (parentId == null) return null;
  const parent = await prisma.customer.findFirst({
    where: { id: parentId, companyId, isDeleted: false },
    select: { id: true, name: true },
  });
  if (!parent) throw new UserFacingError("That parent customer does not exist");

  if (!conn?.realmId) return { customerId: parent.id, qboId: null };

  const link = await prisma.customerQb.findUnique({
    where: { customerId_realmId: { customerId: parent.id, realmId: conn.realmId } },
    select: { qboId: true, raw: true },
  });
  if (!link)
    throw new UserFacingError(
      `"${parent.name}" has not been synced to QuickBooks yet, so nothing can be added under it. Sync QuickBooks from Settings first.`
    );

  // QuickBooks caps the chain at five levels and rejects the sixth with a fault the technician
  // cannot interpret. `Level` is read-only but present on every row we mirror, so this is a JSON
  // read rather than an ancestor walk — and it fails here, naming the parent, before anything
  // is written locally.
  const level = Number((link.raw as { Level?: unknown } | null)?.Level);
  if (Number.isFinite(level) && level >= 4)
    throw new UserFacingError(
      `"${parent.name}" is already as deep as QuickBooks allows (five levels). Choose a customer higher up.`
    );

  return { customerId: parent.id, qboId: link.qboId };
}

/** What the picker and the create path both return, so callers treat them alike. */
export interface LinkedCustomer {
  customerId: number;
  name: string;
  qboId: string | null;
  /**
   * Address components the parse could not find in what was typed (T-65). The parser never
   * invents one — a guessed ZIP silently moves the tax jurisdiction — so this is how the UI
   * knows to ask. Empty when the address was complete, absent, or unparseable.
   */
  addressMissing?: string[];
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
  if (!name) throw new UserFacingError("A customer name is required");

  const email = str(input.email);
  // The address itself is NOT echoed back or logged (T-53): the person typed it, they can see
  // it, and repeating a customer's email into a log line is the leak, not the help.
  if (email && !EMAIL_OK.test(email)) throw new UserFacingError("That email address is not valid");

  // The parent is resolved BEFORE anything else, because it scopes the duplicate check below and
  // because a bad one should fail with a message about the parent rather than leave a half-made
  // customer behind.
  const parent = await resolveParent(companyId, input.parentId ?? null, conn);
  const parentId = parent?.customerId ?? null;

  // Scoped to the same parent. QuickBooks' DisplayName is SIBLING-unique, not realm-unique —
  // proved against the sandbox, which accepted "Mark Cho:Building 1" while
  // "Mahee Zentrades:Building 1" already existed. An unscoped check refused a second
  // "Building 1" that QuickBooks would have taken, and the technician was told to pick the
  // existing one, which is a different building on a different site.
  //
  // A row hidden from search (inactive or soft-deleted) still matches: it used to refuse the
  // name while being absent from the list it told the technician to pick from — a dead end with
  // no third option on that screen. A hidden match is revived instead.
  const existing = await prisma.customer.findFirst({
    where: { companyId, parentId, name },
    select: { id: true, isActive: true, isDeleted: true },
  });
  if (existing?.isActive && !existing.isDeleted)
    throw new UserFacingError(
      `"${name}" is already one of your customers — pick them from the list instead`
    );
  if (existing) {
    // The address the technician just entered is applied to the revived row too. Reviving used to
    // flip the flags and return, silently discarding it — so a customer whose name had been used
    // before came back with the old address and nothing on screen said so. The parent already
    // matches by construction: `existing` was looked up under it.
    const revivedAddr = await parseAddress(input.address);
    const revived = await prisma.customer.update({
      where: { id: existing.id },
      data: {
        isActive: true,
        isDeleted: false,
        updatedBy: null,
        ...(str(input.address)
          ? {
              address: str(input.address),
              addressLine1: revivedAddr.line1,
              addressLine2: revivedAddr.line2,
              city: revivedAddr.city,
              state: revivedAddr.state,
              postalCode: revivedAddr.postalCode,
              country: revivedAddr.country,
            }
          : {}),
      },
    });
    logger.info("Revived a hidden customer rather than refusing the name", {
      companyId,
      customerId: revived.id,
    });
    return { customerId: revived.id, name, qboId: null };
  }

  // Structure the typed address so QuickBooks gets components rather than a line of prose. The
  // freeform text is stored either way — the parse is an addition, never a replacement, and it
  // degrades to nulls rather than failing the create.
  const parsed = await parseAddress(input.address);

  const customer = await prisma.customer.create({
    data: {
      companyId,
      name,
      email,
      phone: str(input.phone),
      address: str(input.address),
      parentId,
      addressLine1: parsed.line1,
      addressLine2: parsed.line2,
      city: parsed.city,
      state: parsed.state,
      postalCode: parsed.postalCode,
      country: parsed.country,
    },
  });

  if (!conn?.realmId)
    return { customerId: customer.id, name, qboId: null, addressMissing: parsed.missing };

  try {
    const qboId = await pushCustomerToQbo(conn, companyId, conn.realmId, customer.id, {
      ...input,
      name,
      parentQboId: parent?.qboId ?? null,
      addr: toBillAddr({
        addressLine1: parsed.line1,
        addressLine2: parsed.line2,
        city: parsed.city,
        state: parsed.state,
        postalCode: parsed.postalCode,
        country: parsed.country,
      }) ?? (str(input.address) ? { Line1: str(input.address)! } : undefined),
    });
    return { customerId: customer.id, name, qboId, addressMissing: parsed.missing };
  } catch (e) {
    // Undo the local row. Left behind, it wedges the name: the retry hits the "already one of
    // your customers" guard above, the picker offers a customer QuickBooks has never heard of,
    // and completing the quote fails on the same duplicate every time. Nothing references it
    // yet, so deleting is safe (customer_qb cascades).
    await prisma.customer.delete({ where: { id: customer.id } }).catch((delErr) =>
      logger.error("Could not roll back a customer after its QuickBooks push failed", {
        companyId,
        customerId: customer.id,
        error: delErr instanceof Error ? delErr.message : String(delErr),
      })
    );
    throw e;
  }
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
  input: NewQboCustomer & { parentQboId?: string | null; addr?: Record<string, string> }
): Promise<string> {
  const displayName = customerDisplayName(input.name);
  const email = str(input.email);

  // The address and the parent are resolved HERE, not at the call site. Both used to be passed
  // in by `createCustomer` alone, so the completion-time path — the one that runs when a quote
  // is posted for a customer QuickBooks has not seen — created the customer with no address at
  // all and, for a sub-customer, as a TOP-LEVEL customer detached from its property. The
  // estimate posts fine, so nothing surfaces it. Owning both in one place means no caller can
  // drop them by omission.
  const own = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      parentId: true,
      address: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
    },
  });
  const addr =
    input.addr ??
    toBillAddr(own ?? {}) ??
    // Freeform is the last resort, so a customer typed before the structured columns existed
    // still reaches QuickBooks with the address someone entered.
    ((str(own?.address) ?? str(input.address))
      ? { Line1: (str(own?.address) ?? str(input.address))! }
      : undefined);

  let parentQboId = input.parentQboId ?? null;
  if (parentQboId == null && own?.parentId != null) {
    const parentLink = await prisma.customerQb.findUnique({
      where: { customerId_realmId: { customerId: own.parentId, realmId } },
      select: { qboId: true },
    });
    // A parent that has not synced cannot be referenced. Creating the child as a root anyway
    // would put a job in the books under nothing, so this refuses instead — the same ordering
    // rule the create path enforces, applied where it actually matters.
    if (!parentLink)
      throw new UserFacingError(
        "This customer sits under a parent that has not been synced to QuickBooks yet. Sync QuickBooks from Settings, then try again."
      );
    parentQboId = parentLink.qboId;
  }
  let created: { Customer: { Id: string; FullyQualifiedName?: string } };
  try {
    created = await qboFetch(conn, "/customer", {
      method: "POST",
      body: JSON.stringify({
        DisplayName: displayName,
        ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
        ...(str(input.phone) ? { PrimaryPhone: { FreeFormNumber: str(input.phone) } } : {}),
        ...(addr ? { BillAddr: addr } : {}),
        // A sub-customer in QuickBooks is a Job under a parent (T-64). Both fields are required
        // together: ParentRef alone leaves a plain customer nested oddly, and Job alone is
        // rejected. FullyQualifiedName then comes back as "Parent:Child", which is what the
        // picker shows to tell two same-named jobs apart.
        ...(parentQboId ? { ParentRef: { value: parentQboId }, Job: true } : {}),
      }),
    });
  } catch (e) {
    const body = e instanceof Error ? e.message : String(e);
    if (/6240|Duplicate Name/i.test(body))
      throw new UserFacingError(
        `"${displayName}" already exists in QuickBooks (names are shared with vendors and employees). Pick the existing customer, or use a different name.`
      );
    throw e;
  }
  const qboId = String(created.Customer.Id);
  const qb = {
    qboId,
    displayName,
    // QuickBooks computes this; for a top-level customer it equals DisplayName.
    fullyQualifiedName: (created.Customer as { FullyQualifiedName?: string }).FullyQualifiedName ?? displayName,
    raw: created.Customer as object,
    syncedAt: new Date(),
  };
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
  if (!realmId) throw new UserFacingError("QuickBooks connection has no realm — reconnect from Settings");

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
  //
  // A blank name is refused rather than defaulted. The old fallback created a QuickBooks
  // customer literally called "Customer" in the client's books — a real record, in their
  // accounting system, that someone has to find and merge. Refusing sends the technician back
  // to the picker, which is the fix.
  const name = customerDisplayName(fallback.name);
  if (!name)
    throw new Error(
      "This quote has no customer. Choose or add one on the estimate before sending it to QuickBooks."
    );
  const customer =
    // Scoped to top-level: this path has only a free-text name off the quote, no parent, so the
    // customer it adopts or creates is a root one. Without the scope it could adopt a JOB that
    // happens to share the name with an unrelated property's building.
    (await prisma.customer.findFirst({
      where: { companyId, parentId: null, name },
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
    // A bounded existence probe, not a mirror read: one row is a complete answer.
    { pageSize: 1, maxPages: 1, expectAll: false }
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
  input: {
    id: number | null;
    name: string;
    ratePercent: number;
    /** Undefined means "leave as it is" — see the update branch. */
    isActive?: boolean;
    isDefault?: boolean;
  },
  actingUserId: bigint | null
) {
  // The source-of-truth rule, enforced here rather than only in the UI: a connected company's
  // tax comes from the connected system. Refusing with the reason beats a rate that saves and
  // is then quietly never applied.
  const { external } = await taxSourceIsExternal(companyId);
  if (external)
    throw new UserFacingError(
      "Your sales tax comes from QuickBooks while it is connected. Add or change the rate in QuickBooks, then sync."
    );

  // findFirst with isDeleted, not findUnique on the name key: a soft-deleted row would
  // otherwise hold its name forever and refuse a rate the settings screen cannot even show.
  const clash = await prisma.salesTax.findFirst({
    where: { companyId, name: input.name, isDeleted: false },
    select: { id: true },
  });
  if (clash && clash.id !== input.id)
    throw new UserFacingError(`You already have a rate called "${input.name}"`);

  return prisma.$transaction(async (tx) => {
    // Clear first, then set. `sales_tax_one_default_per_company` is a NON-DEFERRABLE partial
    // unique index, checked at statement end rather than commit — so writing the new default
    // before clearing the old one raises 23505 and the very first "make default" fails.
    if (input.isDefault)
      await tx.salesTax.updateMany({
        where: { companyId, isDefault: true },
        data: { isDefault: false },
      });

    if (input.id == null)
      return tx.salesTax.create({
        data: {
          companyId,
          name: input.name,
          source: "MANUAL",
          ratePercent: input.ratePercent,
          isActive: input.isActive ?? true,
          isDefault: input.isDefault ?? false,
          createdBy: actingUserId,
          updatedBy: actingUserId,
        },
      });

    const owned = await tx.salesTax.findFirst({
      where: { id: input.id, companyId, isDeleted: false },
      select: { id: true },
    });
    if (!owned) throw new UserFacingError("That rate does not belong to this company");
    return tx.salesTax.update({
      where: { id: input.id },
      data: {
        name: input.name,
        ratePercent: input.ratePercent,
        // Only written when the caller actually said so. Treating an absent field as `false`
        // meant correcting a rate's percentage silently cleared the company's default, and
        // every estimate afterwards started untaxed with nothing on screen to say so.
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
        updatedBy: actingUserId,
      },
    });
  });
}

/**
 * Turn a rate off, or back on — including a rate that came from QuickBooks.
 *
 * Deliberately NOT routed through `upsertSalesTax`, whose first act is to refuse every write
 * while a connected system owns the company's tax. That guard is right for what it was written
 * for: a name or a percentage typed here would be saved and then never applied, so refusing with
 * the reason beats accepting it silently. It is wrong for this, and it made the ingested rates —
 * the only ones a connected company has — the exact set that could not be switched off.
 *
 * Availability is a CLARA-side decision about what this company is offered, not a claim about
 * what QuickBooks holds. The ingest already assumes an admin can make it: it refreshes a rate's
 * name on rename but deliberately never forces `is_active` back to true, precisely so a rate
 * someone switched off is not silently switched on by the next sync. Until now nothing could
 * write the flag it was protecting.
 *
 * Nothing is sent to QuickBooks. The rate still exists there, and a later sync still sees it.
 *
 * Deactivating the default clears the default in the same transaction. Left set, the settings
 * screen would keep showing it as the default while every new estimate started untaxed — and
 * `defaultSalesTax` filters on `is_active`, so the two would disagree with nothing to explain it.
 */
export async function setSalesTaxActive(
  companyId: number,
  id: number,
  isActive: boolean,
  actingUserId: bigint | null
) {
  return prisma.$transaction(async (tx) => {
    const owned = await tx.salesTax.findFirst({
      where: { id, companyId, isDeleted: false },
      select: { id: true, isDefault: true },
    });
    if (!owned) throw new UserFacingError("That rate does not belong to this company");
    if (!isActive && owned.isDefault)
      await tx.salesTax.updateMany({
        where: { companyId, isDefault: true },
        data: { isDefault: false },
      });
    return tx.salesTax.update({
      where: { id },
      data: { isActive, ...(isActive ? {} : { isDefault: false }), updatedBy: actingUserId },
    });
  });
}

/** Move (or clear) the default rate. Null means new estimates start untaxed. */
export async function setDefaultSalesTax(companyId: number, id: number | null) {
  const { external } = await taxSourceIsExternal(companyId);
  await prisma.$transaction(async (tx) => {
    if (id != null) {
      const owned = await tx.salesTax.findFirst({
        where: { id, companyId, isActive: true, isDeleted: false },
        select: { id: true, source: true },
      });
      if (!owned)
        throw new UserFacingError("That rate does not belong to this company, or is inactive");
      // Refuse to make an unusable rate the default: it would show as the default in settings
      // and then be ignored on every estimate.
      if (external && owned.source === "MANUAL")
        throw new UserFacingError(
          "That rate was created here, and your tax comes from QuickBooks while it is connected."
        );
    }
    await tx.salesTax.updateMany({ where: { companyId, isDefault: true }, data: { isDefault: false } });
    if (id != null) await tx.salesTax.update({ where: { id }, data: { isDefault: true } });
  });
}
