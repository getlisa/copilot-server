import { createHash } from "crypto";
import { Prisma, ZtConnection } from "@prisma/client";
import prisma from "./prisma";
import logger from "./logger";
import { ztConnectionFor, ztConnected, ztFetch } from "./zt";

/**
 * ZenTrades sync engine (plan 2.3-2.6), structured on qboIngest.ts:
 *  - one sync at a time per company, claimed on zt_connections.sync_started_at;
 *  - stages are independent (a failed stage never blocks the others), and last_sync_at
 *    advances only when EVERY stage succeeded;
 *  - raw-first: the complete API object lands in zt_*_raw with a content hash, so full-list
 *    polling is cheap and any field is re-projectable without a re-sync;
 *  - Estimates-tab-only scope: tickets/deficiencies are NEVER projected into jobs — the raw
 *    tables ARE the read store. Only the price catalog projects (into Pricebook/PricebookItem,
 *    which the estimating agent already prices from).
 *
 * VERIFY-ON-TEST-ACCOUNT: request/response shapes marked VERIFY below come from real samples
 * or ZenTrades' engineering review but have not run against a live account from this code.
 */

export const ZT_SYNC_CLAIM_STALE_MS = 10 * 60 * 1000;
const SYNC_CLAIM_STALE_MS = ZT_SYNC_CLAIM_STALE_MS;
const PAGE_SIZE = 100;
const MAX_PAGES = 200; // backstop, not a target: 20k rows of anything means something is wrong

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Live progress for the Connections card, keyed by company then by stage (stages run
// concurrently, so each keeps its own line; the card shows them joined). In-memory on
// purpose: one server process serves this (single ECS task / local dev), and a lost progress
// line on restart costs nothing. ponytail: move to the connection row if we ever scale out.
const syncProgress = new Map<number, Map<string, string>>();
export const ztSyncProgressFor = (companyId: number): string | null => {
  const stages = syncProgress.get(companyId);
  return stages && stages.size > 0 ? [...stages.values()].join(" · ") : null;
};
const setProgress = (companyId: number, stage: string, msg: string) => {
  let stages = syncProgress.get(companyId);
  if (!stages) {
    stages = new Map();
    syncProgress.set(companyId, stages);
  }
  stages.set(stage, msg);
};

/** Tiny bounded-concurrency pool (single-threaded JS: the shared index is race-free). */
async function inPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    })
  );
}

const asArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : [];

/** ZenTrades responses vary between {hits:[]}, {list:[]}, and bare arrays. Take what's there. */
const rowsOf = (result: unknown): Record<string, unknown>[] => {
  if (Array.isArray(result)) return asArray(result);
  const r = result as Record<string, unknown> | null;
  return asArray(r?.hits ?? r?.list ?? r?.data ?? r?.items ?? []);
};

// ---------- the run ----------

/** Thrown when the one-sync-at-a-time claim is already held — a conflict, not a failure. */
export class ZtSyncRunningError extends Error {}

export async function syncZtData(companyId: number): Promise<{
  jobs: number;
  deficiencies: number;
  catalog: number;
  tax: number;
  errors: string[];
}> {
  const conn = await ztConnectionFor(companyId);
  if (!ztConnected(conn)) throw new Error("ZenTrades is not connected for this company");

  // One sync at a time: a conditional row claim, the row count is the answer (advisory locks
  // are re-entrant across a pooled connection and guard nothing — QBO's lesson).
  const claim = await prisma.ztConnection.updateMany({
    where: {
      companyId,
      OR: [
        { syncStartedAt: null },
        { syncStartedAt: { lt: new Date(Date.now() - SYNC_CLAIM_STALE_MS) } },
      ],
    },
    data: { syncStartedAt: new Date() },
  });
  if (claim.count === 0) {
    // Include the claim's age: a run orphaned by a restart cannot release itself and frees
    // via the 10-minute staleness window — the message should say when that happens.
    const mins = conn.syncStartedAt
      ? Math.round((Date.now() - conn.syncStartedAt.getTime()) / 60_000)
      : null;
    throw new ZtSyncRunningError(
      mins != null
        ? `A ZenTrades sync is already running (started ${mins} min ago; a stalled run frees after 10)`
        : "A ZenTrades sync is already running for this company"
    );
  }

  const errors: string[] = [];
  let jobs = 0;
  let deficiencies = 0;
  let catalog = 0;
  let tax = 0;
  try {
    // Every stage attempted even when another failed — independent mirrors, idempotent
    // upserts. What must not happen is a partial run counting as fresh. The three stages run
    // CONCURRENTLY, and jobs additionally pool page fetches (collections' pattern: they
    // parallel-fetch invoice pages once the count is known). Total concurrency against their
    // API stays small and bounded (~stages + jobs pool ≈ 5) — no rate limiting exists on
    // their side to save us from more than that.
    const [jobsR, defsR, catR, taxR] = await Promise.allSettled([
      ingestJobs(conn, companyId),
      ingestDeficiencies(conn, companyId),
      ingestCatalog(conn, companyId),
      ingestZtSalesTax(conn, companyId),
    ]);
    if (jobsR.status === "fulfilled") jobs = jobsR.value;
    else errors.push(`jobs: ${jobsR.reason instanceof Error ? jobsR.reason.message : String(jobsR.reason)}`);
    if (defsR.status === "fulfilled") deficiencies = defsR.value;
    else errors.push(`deficiencies: ${defsR.reason instanceof Error ? defsR.reason.message : String(defsR.reason)}`);
    if (catR.status === "fulfilled") catalog = catR.value;
    else errors.push(`catalog: ${catR.reason instanceof Error ? catR.reason.message : String(catR.reason)}`);
    if (taxR.status === "fulfilled") tax = taxR.value;
    else errors.push(`tax: ${taxR.reason instanceof Error ? taxR.reason.message : String(taxR.reason)}`);
    await prisma.ztConnection.update({
      where: { companyId },
      data:
        errors.length === 0
          ? { lastSyncAt: new Date(), lastSyncError: null }
          : { lastSyncError: errors.join(" | ") },
    });
  } finally {
    syncProgress.delete(companyId);
    // Whatever happened, release the claim: a failed sync must not block the retry.
    await prisma.ztConnection.updateMany({
      where: { companyId },
      data: { syncStartedAt: null },
    });
  }
  logger.info("ZenTrades sync finished", { companyId, jobs, deficiencies, catalog, tax, errors });
  return { jobs, deficiencies, catalog, tax, errors };
}

// ---------- jobs ----------

/**
 * Tickets via POST /api/ticket/search/filtered (ES-backed; returns rich objects incl.
 * updatedAt, embedded customer/serviceAddress/taxZone, openDeficiencyCount — verified against
 * a real sample). Contract taken from collection_agent_backend's production invoice
 * search/filtered call (same ES infrastructure): pagination + sort ride the QUERY STRING
 * (sortBy[]/page/size/searchQuery, page 1-based, loop until a short page) and the BODY is the
 * filters object itself — {terms: [], dependency: []} = unfiltered. That matches both Joi
 * errors seen live ("filters.from is not allowed"; "searchQuery and filters both cannot be
 * empty"). VERIFY remaining: whether `terms` accepts an updatedAt range for true incremental
 * fetch — until then, full-list poll with content_hash skipping unchanged rows.
 */
async function ingestJobs(conn: ZtConnection, companyId: number): Promise<number> {
  setProgress(companyId, "jobs", "Jobs: fetching…");
  let synced = 0;
  let pagesDone = 0;

  const fetchPage = (page: number) => {
    const qs = new URLSearchParams();
    qs.append("sortBy[]", JSON.stringify({ updatedAt: "desc" }));
    qs.append("page", String(page));
    qs.append("size", String(PAGE_SIZE));
    qs.append("searchQuery", "");
    return ztFetch(conn, `/api/ticket/search/filtered?${qs.toString()}`, {
      method: "POST",
      body: { terms: [], dependency: [] },
    });
  };

  // Batched per page: ONE existing-hash lookup + ONE bulk INSERT..ON CONFLICT statement.
  // Not a $transaction of upserts: the app's pool runs at connection_limit=1 (Supabase
  // pgbouncer), so a long multi-statement transaction starves every other query in the
  // process — a live 10s pool-timeout failure. A single statement holds the connection for
  // milliseconds. Unchanged rows (the common case on a re-sync) cost one query per page.
  const upsertPage = async (rows: Record<string, unknown>[]): Promise<number> => {
    // Deduped by id — ON CONFLICT cannot update the same row twice in one statement.
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const id = String(row.id ?? "");
      if (id) byId.set(id, row);
    }
    if (byId.size === 0) return 0;
    const existing = await prisma.ztJobRaw.findMany({
      where: { companyId, ztTicketId: { in: [...byId.keys()] } },
      select: { ztTicketId: true, contentHash: true },
    });
    const hashById = new Map(existing.map((e) => [e.ztTicketId, e.contentHash]));
    const changed = [...byId.entries()]
      .map(([id, row]) => ({ id, row, contentHash: hash(row) }))
      .filter((r) => hashById.get(r.id) !== r.contentHash);
    if (changed.length === 0) return 0;
    await prisma.$executeRaw`
      INSERT INTO zt_jobs_raw
        (company_id, zt_ticket_id, ticket_number, zt_updated_at, raw_payload, content_hash, created_at, updated_at)
      VALUES ${Prisma.join(
        changed.map(
          ({ id, row, contentHash }) =>
            Prisma.sql`(${companyId}, ${id}, ${
              row.ticketNumber != null ? String(row.ticketNumber) : null
            }, ${typeof row.updatedAt === "string" ? new Date(row.updatedAt) : null}, ${JSON.stringify(
              row
            )}::jsonb, ${contentHash}, now(), now())`
        )
      )}
      ON CONFLICT (company_id, zt_ticket_id) DO UPDATE SET
        raw_payload   = EXCLUDED.raw_payload,
        content_hash  = EXCLUDED.content_hash,
        ticket_number = EXCLUDED.ticket_number,
        zt_updated_at = EXCLUDED.zt_updated_at,
        updated_at    = now()
    `;
    return changed.length;
  };

  // Page 1 tells us the total; the rest fetch in a small pool (collections' pattern for
  // invoice pages). No count in the response → sequential until a short page.
  const first = await fetchPage(1);
  const firstRows = rowsOf(first);
  synced += await upsertPage(firstRows);
  pagesDone = 1;
  const countRaw = (first as Record<string, unknown> | null)?.count ?? (first as Record<string, unknown> | null)?.total;
  const total = Number(countRaw);
  if (Number.isFinite(total) && total > PAGE_SIZE) {
    const totalPages = Math.min(Math.ceil(total / PAGE_SIZE), MAX_PAGES);
    setProgress(companyId, "jobs", `Jobs: 1/${totalPages} pages…`);
    const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    await inPool(pages, 3, async (page) => {
      const rows = rowsOf(await fetchPage(page));
      synced += await upsertPage(rows);
      pagesDone++;
      setProgress(companyId, "jobs", `Jobs: ${pagesDone}/${totalPages} pages — ${synced} updated…`);
    });
  } else if (firstRows.length >= PAGE_SIZE) {
    for (let page = 2; page <= MAX_PAGES; page++) {
      const rows = rowsOf(await fetchPage(page));
      synced += await upsertPage(rows);
      setProgress(companyId, "jobs", `Jobs: page ${page} — ${synced} updated…`);
      if (rows.length < PAGE_SIZE) break;
    }
  }
  setProgress(companyId, "jobs", `Jobs: done (${synced} updated)`);
  return synced;
}

// ---------- deficiencies ----------

/**
 * Deficiencies via POST /api/common/fp/form/deficiency/list. Their module supports ticketId /
 * date filters (per their engineering review); VERIFY the exact body param names against their
 * fp-deficiency.schema.js — until then a plain paged fetch, content_hash doing the dedup work.
 */
async function ingestDeficiencies(conn: ZtConnection, companyId: number): Promise<number> {
  setProgress(companyId, "deficiencies", "Deficiencies: fetching…");
  let synced = 0;
  // VERIFY: '"limit" is not allowed' — pagination params unknown; single minimal-body fetch
  // until the real payload is captured, same as the ticket search above.
  {
    const result = await ztFetch(conn, "/api/common/fp/form/deficiency/list", {
      method: "POST",
      body: {},
    });
    const rows = rowsOf(result);
    // Same page-batched pattern as jobs: one lookup, one bulk ON CONFLICT statement
    // (pool-of-1 friendly — see upsertPage in ingestJobs).
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const id = String(row.id ?? "");
      if (id) byId.set(id, row);
    }
    if (byId.size > 0) {
      const existing = await prisma.ztDeficiencyRaw.findMany({
        where: { companyId, ztDeficiencyId: { in: [...byId.keys()] } },
        select: { ztDeficiencyId: true, contentHash: true },
      });
      const hashById = new Map(existing.map((e) => [e.ztDeficiencyId, e.contentHash]));
      const changed = [...byId.entries()]
        .map(([id, row]) => ({ id, row, contentHash: hash(row) }))
        .filter((r) => hashById.get(r.id) !== r.contentHash);
      if (changed.length > 0) {
        await prisma.$executeRaw`
          INSERT INTO zt_deficiencies_raw
            (company_id, zt_deficiency_id, zt_ticket_id, status, raw_payload, content_hash, created_at, updated_at)
          VALUES ${Prisma.join(
            changed.map(
              ({ id, row, contentHash }) =>
                Prisma.sql`(${companyId}, ${id}, ${
                  row.ticketId != null ? String(row.ticketId) : null
                }, ${typeof row.status === "string" ? row.status : null}, ${JSON.stringify(
                  row
                )}::jsonb, ${contentHash}, now(), now())`
            )
          )}
          ON CONFLICT (company_id, zt_deficiency_id) DO UPDATE SET
            raw_payload  = EXCLUDED.raw_payload,
            content_hash = EXCLUDED.content_hash,
            zt_ticket_id = EXCLUDED.zt_ticket_id,
            status       = EXCLUDED.status,
            updated_at   = now()
        `;
      }
      synced += changed.length;
    }
  }
  return synced;
}

// ---------- price catalog ----------

/**
 * Mode first, every sync: a company has EITHER a pricebook OR flat-rate items, decided by
 * GET /api/setting/allSettings → pricebooksettings.isPricebookEnabled (an admin can flip it).
 */
async function ingestCatalog(conn: ZtConnection, companyId: number): Promise<number> {
  setProgress(companyId, "catalog", "Catalog: fetching…");
  const settings = (await ztFetch(conn, "/api/setting/allSettings")) as Record<
    string,
    unknown
  > | null;
  const pbSettings = (settings?.pricebooksettings ?? settings?.pricebookSettings) as
    | { isPricebookEnabled?: boolean }
    | undefined;
  const pricebookMode = pbSettings?.isPricebookEnabled === true;

  const rows: { id: string; row: Record<string, unknown> }[] = [];
  if (pricebookMode) {
    // updatedAt-sorted ES search → true incremental is possible later; full read for now.
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await ztFetch(conn, "/api/pricebook/materials/search", {
        method: "POST",
        body: {
          from: page * PAGE_SIZE,
          size: PAGE_SIZE,
          sort: [{ updatedAt: { order: "desc" } }],
          searchQuery: "",
        },
      });
      const pageRows = rowsOf(result);
      pageRows.forEach((r) => r.id != null && rows.push({ id: String(r.id), row: r }));
      if (pageRows.length < PAGE_SIZE) break;
    }
  } else {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await ztFetch(conn, "/api/flatrateitem/company", {
        method: "POST",
        body: { page, limit: PAGE_SIZE, skipInActive: false },
      });
      const pageRows = rowsOf(result);
      pageRows.forEach((r) => r.id != null && rows.push({ id: String(r.id), row: r }));
      if (pageRows.length < PAGE_SIZE) break;
    }
  }

  const kind = pricebookMode ? "PRICEBOOK" : "FLATRATE";
  // The projection target: one ZenTrades-sourced book per company, priced LAST (priority 9999)
  // so any admin-uploaded book outranks it — the priority rule as plain data, no pricing-code
  // changes. The estimating agent picks it up through the existing pricing pool.
  const book = await prisma.pricebook.upsert({
    where: { companyId_name: { companyId, name: "ZenTrades catalog" } },
    update: {},
    create: { companyId, name: "ZenTrades catalog", priority: 9999, source: "ZENTRADES" },
  });

  let synced = 0;
  // One lookup for the whole catalog; the write path below stays per-CHANGED-row because the
  // projection needs each created PricebookItem id back. ponytail: fine at catalog sizes —
  // revisit with createMany + externalId read-back if a client ever has 10k+ items.
  const existingRows = await prisma.ztCatalogRaw.findMany({
    where: { companyId, kind, ztItemId: { in: rows.map((r) => r.id) } },
    select: { ztItemId: true, contentHash: true, projectedItemId: true },
  });
  const existingById = new Map(existingRows.map((e) => [e.ztItemId, e]));
  for (const { id: ztItemId, row } of rows) {
    const contentHash = hash(row);
    const existing = existingById.get(ztItemId);
    if (existing?.contentHash === contentHash && existing.projectedItemId != null) continue;

    // Raw first, ALWAYS — an unmappable row still lands in the raw store, so a later fix to
    // the field mapping re-projects it without a re-sync (the raw-ingest rule).
    await prisma.ztCatalogRaw.upsert({
      where: { companyId_kind_ztItemId: { companyId, kind, ztItemId } },
      update: { rawPayload: row as Prisma.InputJsonValue, contentHash },
      create: {
        companyId,
        kind,
        ztItemId,
        rawPayload: row as Prisma.InputJsonValue,
        contentHash,
      },
    });

    // VERIFY field names against real payloads: common shapes covered defensively.
    const description = String(
      row.name ?? row.description ?? row.itemName ?? row.title ?? ""
    ).trim();
    const priceRaw = row.price ?? row.unitPrice ?? row.rate ?? row.sellingPrice ?? null;
    const price = priceRaw != null ? Number(priceRaw) : NaN;
    if (!description || !Number.isFinite(price)) continue; // unmappable: raw kept, projection skipped
    const code = String(row.code ?? row.sku ?? row.itemCode ?? `ZT-${ztItemId}`);
    const unit = typeof row.unit === "string" && row.unit ? row.unit : "EA";

    const projected = await prisma.pricebookItem.upsert({
      where:
        existing?.projectedItemId != null
          ? { id: existing.projectedItemId }
          : { id: -1 }, // no prior projection: force the create branch
      update: { code, description, unit, unitPrice: price },
      create: {
        companyId,
        code,
        description,
        unit,
        unitPrice: price,
        pricebookId: book.id,
        source: "ZENTRADES",
        externalId: ztItemId,
      },
    });
    await prisma.ztCatalogRaw.update({
      where: { companyId_kind_ztItemId: { companyId, kind, ztItemId } },
      data: { projectedItemId: projected.id },
    });
    synced++;
  }
  return synced;
}

// ---------- sales tax ----------

/**
 * The company's ZenTrades tax rates → CLARA's sales_tax entity (the QBO ingest pattern, §4.6
 * rules honored: match the ZenTrades id first, never write is_default — an import must not
 * silently start taxing estimates; the admin picks the default in Tax Settings). Rates land
 * with source ZENTRADES, so taxSourceIsExternal + salesTaxUsable make them the usable set
 * while connected, exactly like QBO rates. sales_tax_zt.raw keeps the provider object the
 * estimate post sends back.
 * VERIFY: the coderate list's row shape (we have the verified request, not a captured
 * response) — mapped defensively; and whether its rows share id-space with serviceAddress
 * .taxZone (quote seeding keys by zone id).
 */
async function ingestZtSalesTax(conn: ZtConnection, companyId: number): Promise<number> {
  setProgress(companyId, "tax", "Tax rates: fetching…");
  const result = (await ztFetch(
    conn,
    "/api/salestax/coderate/list/?hideInactive=false"
  )) as Record<string, unknown> | null;
  // Verified live (company 3): the response is {salesTaxes: [zones], groupTaxes, purchaseTaxes}.
  // A zone here has NO top-level combineTax — the effective percent is the sum of its rate
  // rows (state + local cascade, same numbers the ticket-embedded zone pre-computes).
  const zones = asArray(result?.salesTaxes);
  const rows = zones.length > 0 ? zones : rowsOf(result);
  let synced = 0;
  for (const row of rows) {
    // Inactive/deleted zones stay out — this test company alone carries 826 zones of which
    // most are retired; importing them would bury the usable list.
    if (row.isDeleted === true || row.isActive === false) continue;
    const ztRateId = String(row.id ?? "");
    if (!ztRateId) continue;
    const rates = asArray(row.salesTaxRates);
    const summed = rates.reduce((sum, r) => sum + (Number(r.combineTax) || 0), 0);
    const percent = Number(row.combineTax ?? (rates.length > 0 ? summed : NaN));
    // ratePercent is Decimal(6,4): |value| < 100. A zone outside that is junk data (seen live:
    // test zones summing past 100%) — refuse the one zone, never the whole stage (QBO's rule).
    if (!Number.isFinite(percent) || percent < 0 || percent >= 100) continue;
    const name = String(
      row.name ?? row.locationCode ?? row.description ?? `ZenTrades ${percent}%`
    ).slice(0, 120);
    const link = await prisma.salesTaxZt.findUnique({
      where: { companyId_ztRateId: { companyId, ztRateId } },
      select: { salesTaxId: true },
    });
    if (link) {
      // Name and percent follow ZenTrades (theirs is the source of truth while connected);
      // is_default and is_active stay the admin's. A rename that collides with another row's
      // name (sales_tax is unique per company+name; ZenTrades zone names repeat freely) keeps
      // the old name and still updates the percent — the money number must never be stale.
      try {
        await prisma.salesTax.update({
          where: { id: link.salesTaxId },
          data: { name, ratePercent: percent },
        });
      } catch {
        await prisma.salesTax.update({
          where: { id: link.salesTaxId },
          data: { ratePercent: percent },
        });
      }
      await prisma.salesTaxZt.update({
        where: { companyId_ztRateId: { companyId, ztRateId } },
        data: { raw: row as Prisma.InputJsonValue },
      });
    } else {
      // Adopt an unlinked same-name ZENTRADES row first (created by quote seeding before this
      // stage ran, or by an earlier partial run) — never a MANUAL/QBO row (QBO ingest's rule:
      // adopting one rewrites an admin's hand-typed rate and flips its provenance).
      const adoptable = await prisma.salesTax.findFirst({
        where: { companyId, name, source: "ZENTRADES", zt: { none: {} } },
        select: { id: true },
      });
      let salesTaxId: number;
      if (adoptable) {
        await prisma.salesTax.update({
          where: { id: adoptable.id },
          data: { ratePercent: percent },
        });
        salesTaxId = adoptable.id;
      } else {
        const create = (n: string) =>
          prisma.salesTax.create({
            data: {
              companyId,
              name: n,
              ratePercent: percent,
              source: "ZENTRADES",
              isDefault: false,
            },
            select: { id: true },
          });
        try {
          salesTaxId = (await create(name)).id;
        } catch {
          // Duplicate name — ZenTrades zone names repeat, and MANUAL/QBO rows can own one
          // too. The zone id makes it unique (QBO's sibling-collision suffix, permanent here
          // because the zone id IS the identity).
          salesTaxId = (await create(`${name.slice(0, 100)} (${ztRateId})`)).id;
        }
      }
      await prisma.salesTaxZt.create({
        data: {
          salesTaxId,
          companyId,
          ztRateId,
          raw: row as Prisma.InputJsonValue,
        },
      });
    }
    synced++;
    if (synced % 50 === 0) setProgress(companyId, "tax", `Tax rates: ${synced} imported…`);
  }
  setProgress(companyId, "tax", `Tax rates: done (${synced})`);
  return synced;
}

// ---------- reads for the Estimates tab ----------

export interface ZtJobChoice {
  ztTicketId: string;
  ticketNumber: string | null;
  jobDescription: string;
  jobStatus: string | null;
  customerName: string | null;
  serviceAddressName: string | null;
  scheduledStartTime: string | null;
  openDeficiencyCount: number;
  ztUpdatedAt: string | null;
}

/** The job picker's rows, straight from the raw store. */
export async function listZtJobs(companyId: number, q?: string): Promise<ZtJobChoice[]> {
  const rows = await prisma.ztJobRaw.findMany({
    where: { companyId },
    orderBy: { ztUpdatedAt: "desc" },
    take: 200,
  });
  const needle = q?.trim().toLowerCase();
  const choices = rows.map((r) => {
    const p = r.rawPayload as Record<string, unknown>;
    const customer = p.customer as Record<string, unknown> | undefined;
    const addr = p.serviceAddress as Record<string, unknown> | undefined;
    return {
      ztTicketId: r.ztTicketId,
      ticketNumber: r.ticketNumber,
      jobDescription: String(p.jobDescription ?? ""),
      jobStatus: typeof p.jobStatus === "string" ? p.jobStatus : null,
      customerName:
        (customer?.displayName as string) ?? (customer?.name as string) ?? null,
      serviceAddressName:
        (addr?.displayName as string) ?? (addr?.name as string) ?? null,
      scheduledStartTime:
        typeof p.scheduledStartTime === "string" ? p.scheduledStartTime : null,
      openDeficiencyCount: Number(p.openDeficiencyCount ?? 0),
      ztUpdatedAt: r.ztUpdatedAt?.toISOString() ?? null,
    };
  });
  if (!needle) return choices;
  return choices.filter((c) =>
    [c.ticketNumber, c.jobDescription, c.customerName, c.serviceAddressName]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(needle))
  );
}

export const ztJobRawFor = (companyId: number, ztTicketId: string) =>
  prisma.ztJobRaw.findUnique({ where: { companyId_ztTicketId: { companyId, ztTicketId } } });

export const openZtDeficienciesFor = (companyId: number, ztTicketId: string) =>
  prisma.ztDeficiencyRaw.findMany({
    where: { companyId, ztTicketId, OR: [{ status: null }, { status: { not: "Resolved" } }] },
    orderBy: { id: "asc" },
  });

// ---------- quote seeding ----------

export interface ZtQuoteSeed {
  customerId: number | null;
  customerName: string | null;
  customerAddress: string | null;
  customerPhone: string | null;
  salesTaxId: number | null;
  taxRatePercent: number | null;
}

const addrLine = (a: Record<string, unknown> | undefined): string | null => {
  if (!a) return null;
  const parts = [a.addressLine1, a.city, a.state, a.zipcode].filter(Boolean).map(String);
  return parts.length ? parts.join(", ") : null;
};

/**
 * Everything a new quote inherits from its ZenTrades ticket (plan 2.5 + tax seeding):
 *  - the CLARA customer, adopted by ZenTrades id first (customer_zt) so a second quote for the
 *    same payer never duplicates the row, created from the embedded billing customer otherwise.
 *    Billing/location split: the payer is the ticket's `customer`; the location's own
 *    customerId is never used for billing fields.
 *  - the tax snapshot, from the service address's tax zone: the zone's rate becomes (or finds)
 *    a source-ZENTRADES sales_tax row linked via sales_tax_zt, and the quote snapshots it —
 *    same snapshot semantics as the QBO tax model.
 */
export async function seedQuoteFromZtTicket(
  companyId: number,
  ztTicketId: string
): Promise<ZtQuoteSeed | null> {
  const raw = await ztJobRawFor(companyId, ztTicketId);
  if (!raw) return null;
  const p = raw.rawPayload as Record<string, unknown>;
  const customer = p.customer as Record<string, unknown> | undefined;
  const serviceAddress = p.serviceAddress as Record<string, unknown> | undefined;

  // -- customer adoption --
  let customerId: number | null = null;
  const ztCustomerId = customer?.id != null ? String(customer.id) : null;
  const name = String(customer?.displayName ?? customer?.name ?? "").trim();
  if (ztCustomerId && name) {
    const link = await prisma.customerZt.findUnique({
      where: { companyId_ztCustomerId: { companyId, ztCustomerId } },
      select: { customerId: true },
    });
    if (link) {
      customerId = link.customerId;
    } else {
      const billing = customer?.billingAddress as Record<string, unknown> | undefined;
      const created = await prisma.customer.create({
        data: {
          companyId,
          name,
          email: typeof customer?.email === "string" && customer.email ? customer.email : null,
          phone:
            typeof customer?.landline === "string" && customer.landline
              ? customer.landline
              : typeof customer?.cellphone === "string" && customer.cellphone
                ? customer.cellphone
                : null,
          address: addrLine(billing),
          addressLine1: (billing?.addressLine1 as string) ?? null,
          city: (billing?.city as string) ?? null,
          state: (billing?.state as string) ?? null,
          postalCode: (billing?.zipcode as string) ?? null,
          country: (billing?.country as string) ?? null,
        },
      });
      await prisma.customerZt.create({
        data: {
          customerId: created.id,
          companyId,
          ztCustomerId,
          raw: customer as Prisma.InputJsonValue,
        },
      });
      customerId = created.id;
    }
  }

  // -- tax snapshot from the service address's zone --
  // Keyed by the ZONE id and storing the ZONE object: verified live, an estimate's salesTax
  // field is the zone object verbatim, so sales_tax_zt.raw must hold what the post sends.
  let salesTaxId: number | null = null;
  let taxRatePercent: number | null = null;
  const taxZone = serviceAddress?.taxZone as Record<string, unknown> | undefined;
  const rates = asArray(taxZone?.salesTaxRates);
  const percent = Number(taxZone?.combineTax ?? rates[0]?.combineTax ?? NaN);
  const taxable = serviceAddress?.isTaxable !== false;
  // Same Decimal(6,4) bound as the ingest: a junk zone on the ticket seeds no tax rather
  // than failing the quote creation.
  if (taxable && taxZone?.id != null && Number.isFinite(percent) && percent >= 0 && percent < 100) {
    const ztRateId = String(taxZone.id);
    const link = await prisma.salesTaxZt.findUnique({
      where: { companyId_ztRateId: { companyId, ztRateId } },
      select: { salesTaxId: true, salesTax: { select: { ratePercent: true } } },
    });
    if (link) {
      salesTaxId = link.salesTaxId;
      taxRatePercent = Number(link.salesTax.ratePercent);
      // Keep the stored zone object current — the estimate post sends it back verbatim.
      await prisma.salesTaxZt.update({
        where: { companyId_ztRateId: { companyId, ztRateId } },
        data: { raw: taxZone as Prisma.InputJsonValue },
      });
    } else {
      const zoneName = String(
        taxZone.name ?? rates[0]?.locationCode ?? `ZenTrades ${percent}%`
      ).slice(0, 120);
      const create = (n: string) =>
        prisma.salesTax.create({
          data: {
            companyId,
            name: n,
            ratePercent: percent,
            source: "ZENTRADES",
            // Never the default: same rule as QBO ingest — an import must not silently start
            // taxing every non-ZenTrades estimate.
            isDefault: false,
          },
          select: { id: true },
        });
      let created: { id: number };
      try {
        created = await create(zoneName);
      } catch {
        // Name collision (unique per company+name; zone names repeat) — the zone id
        // disambiguates permanently.
        created = await create(`${zoneName.slice(0, 100)} (${ztRateId})`);
      }
      await prisma.salesTaxZt.create({
        data: {
          salesTaxId: created.id,
          companyId,
          ztRateId,
          raw: taxZone as Prisma.InputJsonValue,
        },
      });
      salesTaxId = created.id;
      taxRatePercent = percent;
    }
  }

  return {
    customerId,
    customerName: name || null,
    customerAddress: addrLine(serviceAddress),
    customerPhone:
      typeof customer?.landline === "string" && customer.landline ? customer.landline : null,
    salesTaxId,
    taxRatePercent,
  };
}

/**
 * The chat's automatic first message for a ZT-seeded quote — written into the conversation at
 * creation so the technician lands in a chat that already presents the job and its open
 * deficiencies. Deterministic (no LLM call): the picker flow must not wait seconds for a
 * model, and the agent's real turns carry ztChatContext anyway, so continuity holds.
 */
export async function ztWelcomeMessage(
  companyId: number,
  ztTicketId: string
): Promise<string | null> {
  const raw = await ztJobRawFor(companyId, ztTicketId);
  if (!raw) return null;
  const p = raw.rawPayload as Record<string, unknown>;
  const customer = p.customer as Record<string, unknown> | undefined;
  const addr = p.serviceAddress as Record<string, unknown> | undefined;
  const defs = await openZtDeficienciesFor(companyId, ztTicketId);
  const site = [addr?.displayName ?? addr?.name, addr?.city, addr?.state]
    .filter(Boolean)
    .join(", ");
  const payer = (customer?.displayName ?? customer?.name) as string | undefined;
  const lines: string[] = [
    `This estimate is for **ZenTrades job ${raw.ticketNumber ?? raw.ztTicketId}** — ${
      p.jobDescription ?? "(no description)"
    }${site ? ` at ${site}` : ""}${payer ? `, billed to ${payer}` : ""}.`,
  ];
  if (defs.length > 0) {
    lines.push(
      "",
      `The job has **${defs.length} open deficienc${defs.length === 1 ? "y" : "ies"}**:`
    );
    for (const d of defs) {
      const dp = d.rawPayload as Record<string, unknown>;
      const parts = [
        typeof dp.severity === "string" ? `**[${dp.severity}]**` : null,
        dp.question ?? "(unnamed deficiency)",
        dp.recommendation ? `— recommended: ${dp.recommendation}` : null,
      ].filter(Boolean);
      lines.push(`- ${parts.join(" ")}`);
    }
    lines.push(
      "",
      "Tell me which of these to include — or say **cover all of them** and I'll propose the full scope."
    );
  } else {
    lines.push(
      "",
      "No open deficiencies are recorded for this job. Describe the work and I'll build the estimate."
    );
  }
  return lines.join("\n");
}

/** The context block the estimating agent gets for a ZT-seeded quote (plan 2.5). */
export async function ztChatContext(companyId: number, ztTicketId: string): Promise<string | null> {
  const raw = await ztJobRawFor(companyId, ztTicketId);
  if (!raw) return null;
  const p = raw.rawPayload as Record<string, unknown>;
  const customer = p.customer as Record<string, unknown> | undefined;
  const addr = p.serviceAddress as Record<string, unknown> | undefined;
  const defs = await openZtDeficienciesFor(companyId, ztTicketId);
  const defLines = defs
    .map((d) => {
      const dp = d.rawPayload as Record<string, unknown>;
      const parts = [
        typeof dp.severity === "string" ? `[${dp.severity}]` : null,
        dp.question ?? null,
        dp.recommendation ? `— recommended: ${dp.recommendation}` : null,
        dp.reason ? `(reason: ${dp.reason})` : null,
      ].filter(Boolean);
      return `- ${parts.join(" ")}`;
    })
    .join("\n");
  return `THIS ESTIMATE IS FOR A ZENTRADES JOB — treat the following as the job description the technician would otherwise dictate. Use it to propose scope; the technician confirms or refines. Never re-ask details stated here.
Job ${raw.ticketNumber ?? raw.ztTicketId}: ${p.jobDescription ?? "(no description)"}
Customer: ${customer?.displayName ?? customer?.name ?? "unknown"} · Site: ${addr?.displayName ?? addr?.name ?? ""} ${addrLine(addr) ?? ""}
${defs.length > 0 ? `OPEN DEFICIENCIES (${defs.length}) — the likely scope of this estimate:\n${defLines}` : "No open deficiencies recorded for this job."}`;
}
