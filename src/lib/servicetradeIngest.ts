import { createHash } from "crypto";
import { Prisma, ServicetradeConnection } from "@prisma/client";
import prisma from "./prisma";
import logger from "./logger";
import {
  servicetradeConnectionFor,
  servicetradeConnected,
  servicetradeFetch,
  servicetradePageAll,
} from "./servicetrade";
import { listProposalTemplateChoices, matchTemplateToJobType } from "./proposalTemplates";
import type { ZtQuoteSeed } from "./ztIngest";

/**
 * ServiceTrade sync engine — uptickIngest.ts structure, four stages:
 *  - jobs (GET /job?status=all — every status except canceled; their default is scheduled only);
 *  - deficiencies (GET /deficiency);
 *  - lib items (GET /libitem) → one "ServiceTrade catalog" pricebook (priority 9999, any admin
 *    book outranks it) so chat prices from their list and every quote line can carry libItemId;
 *  - tax groups (GET /taxgroup) → sales_tax rows with source SERVICETRADE (the ZenTrades rule:
 *    never is_default; the admin picks). A job's location names its tax group, so a seeded
 *    quote snapshots that rate.
 * One sync at a time per company (sync_started_at claim); incremental via updatedAfter (Unix
 * seconds) from the last COMPLETE run with a 5-minute overlap; raw-first with a content hash;
 * Estimates-tab-only scope (nothing projects into `jobs`).
 */

export const SERVICETRADE_SYNC_CLAIM_STALE_MS = 10 * 60 * 1000;

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const idOf = (v: unknown): string | null => {
  const o = obj(v);
  return o?.id != null ? String(o.id) : null;
};
/** Unix seconds → Date, null when absent. */
const ts = (v: unknown): Date | null => (typeof v === "number" && v > 0 ? new Date(v * 1000) : null);

/** {street, city, state, postalCode} → one line. */
export const addrText = (v: unknown): string | null => {
  const a = obj(v);
  if (!a) return null;
  const parts = [a.street, a.city, a.state, a.postalCode].map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
};

export class ServicetradeSyncRunningError extends Error {}

// ---------- the run ----------

export async function syncServicetradeData(
  companyId: number
): Promise<{ jobs: number; deficiencies: number; items: number; tax: number; errors: string[] }> {
  const conn = await servicetradeConnectionFor(companyId);
  if (!servicetradeConnected(conn)) throw new Error("ServiceTrade is not connected for this company");

  const claim = await prisma.servicetradeConnection.updateMany({
    where: {
      companyId,
      OR: [{ syncStartedAt: null }, { syncStartedAt: { lt: new Date(Date.now() - SERVICETRADE_SYNC_CLAIM_STALE_MS) } }],
    },
    data: { syncStartedAt: new Date() },
  });
  if (claim.count === 0) {
    const mins = conn.syncStartedAt ? Math.round((Date.now() - conn.syncStartedAt.getTime()) / 60_000) : null;
    throw new ServicetradeSyncRunningError(
      mins != null
        ? `A ServiceTrade sync is already running (started ${mins} min ago; a stalled run frees after 10)`
        : "A ServiceTrade sync is already running for this company"
    );
  }

  const since = conn.lastSyncAt ? Math.floor((conn.lastSyncAt.getTime() - 5 * 60_000) / 1000) : null;
  const errors: string[] = [];
  const counts = { jobs: 0, deficiencies: 0, items: 0, tax: 0 };
  try {
    const stages: [keyof typeof counts, Promise<number>][] = [
      ["jobs", ingestJobs(conn, companyId, since)],
      ["deficiencies", ingestDeficiencies(conn, companyId, since)],
      ["items", ingestLibItems(conn, companyId, since)],
      ["tax", ingestTaxGroups(conn, companyId)],
    ];
    const results = await Promise.allSettled(stages.map(([, p]) => p));
    results.forEach((r, i) => {
      const name = stages[i][0];
      if (r.status === "fulfilled") counts[name] = r.value;
      else errors.push(`${name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    });
    await prisma.servicetradeConnection.update({
      where: { companyId },
      data: errors.length === 0 ? { lastSyncAt: new Date(), lastSyncError: null } : { lastSyncError: errors.join(" | ") },
    });
  } finally {
    await prisma.servicetradeConnection.updateMany({ where: { companyId }, data: { syncStartedAt: null } });
  }
  logger.info("ServiceTrade sync finished", { companyId, ...counts, errors });
  return { ...counts, errors };
}

const sinceParam = (since: number | null) => (since ? `&updatedAfter=${since}` : "");

// ---------- jobs ----------

async function ingestJobs(conn: ServicetradeConnection, companyId: number, since: number | null): Promise<number> {
  let synced = 0;
  await servicetradePageAll<{ jobs?: Record<string, unknown>[] }>(
    conn,
    `job?status=all&limit=500${sinceParam(since)}`,
    async (data) => {
      const rows = arr(data.jobs).map((row) => ({ id: String(row.id), row, contentHash: hash(row) }));
      if (rows.length === 0) return;
      const existing = await prisma.servicetradeJobRaw.findMany({
        where: { companyId, stJobId: { in: rows.map((r) => r.id) } },
        select: { stJobId: true, contentHash: true },
      });
      const hashById = new Map(existing.map((e) => [e.stJobId, e.contentHash]));
      const changed = rows.filter((r) => hashById.get(r.id) !== r.contentHash);
      if (changed.length === 0) return;
      await prisma.$executeRaw`
        INSERT INTO servicetrade_jobs_raw
          (company_id, st_job_id, number, status, st_updated_at, raw_payload, content_hash, created_at, updated_at)
        VALUES ${Prisma.join(
          changed.map(
            ({ id, row, contentHash }) =>
              Prisma.sql`(${companyId}, ${id}, ${row.number != null ? String(row.number).slice(0, 64) : null}, ${
                str(row.status)?.slice(0, 64) ?? null
              }, ${ts(row.updated)}, ${JSON.stringify(row)}::jsonb, ${contentHash}, now(), now())`
          )
        )}
        ON CONFLICT (company_id, st_job_id) DO UPDATE SET
          raw_payload   = EXCLUDED.raw_payload,
          content_hash  = EXCLUDED.content_hash,
          number        = EXCLUDED.number,
          status        = EXCLUDED.status,
          st_updated_at = EXCLUDED.st_updated_at,
          updated_at    = now()
      `;
      synced += changed.length;
    }
  );
  return synced;
}

// ---------- deficiencies ----------

async function ingestDeficiencies(conn: ServicetradeConnection, companyId: number, since: number | null): Promise<number> {
  let synced = 0;
  await servicetradePageAll<{ deficiencies?: Record<string, unknown>[] }>(
    conn,
    `deficiency${since ? `?updatedAfter=${since}` : ""}`,
    async (data) => {
      const rows = arr(data.deficiencies).map((row) => ({ id: String(row.id), row, contentHash: hash(row) }));
      if (rows.length === 0) return;
      const existing = await prisma.servicetradeDeficiencyRaw.findMany({
        where: { companyId, stDeficiencyId: { in: rows.map((r) => r.id) } },
        select: { stDeficiencyId: true, contentHash: true },
      });
      const hashById = new Map(existing.map((e) => [e.stDeficiencyId, e.contentHash]));
      const changed = rows.filter((r) => hashById.get(r.id) !== r.contentHash);
      if (changed.length === 0) return;
      await prisma.$executeRaw`
        INSERT INTO servicetrade_deficiencies_raw
          (company_id, st_deficiency_id, st_job_id, st_location_id, status, resolution, raw_payload, content_hash, created_at, updated_at)
        VALUES ${Prisma.join(
          changed.map(
            ({ id, row, contentHash }) =>
              Prisma.sql`(${companyId}, ${id}, ${idOf(row.job)}, ${idOf(row.location)}, ${str(row.status)?.slice(0, 32) ?? null}, ${
                str(row.resolution)?.slice(0, 32) ?? null
              }, ${JSON.stringify(row)}::jsonb, ${contentHash}, now(), now())`
          )
        )}
        ON CONFLICT (company_id, st_deficiency_id) DO UPDATE SET
          raw_payload    = EXCLUDED.raw_payload,
          content_hash   = EXCLUDED.content_hash,
          st_job_id      = EXCLUDED.st_job_id,
          st_location_id = EXCLUDED.st_location_id,
          status         = EXCLUDED.status,
          resolution     = EXCLUDED.resolution,
          updated_at     = now()
      `;
      synced += changed.length;
    }
  );
  return synced;
}

// ---------- lib items (pricebook) ----------

export const SERVICETRADE_PRICEBOOK_NAME = "ServiceTrade catalog";

/** One lib item → PricebookItem fields, or null when inactive/unpriced. `price` is only populated
 *  under a contract context (we pass the vendor's default contract); `cost` is the fallback. */
export function mapServicetradeLibItem(
  row: Record<string, unknown>
): { code: string; description: string; unit: string; price: number } | null {
  if (row.active === false) return null;
  const description = str(row.name);
  const priceRaw = row.price ?? row.cost;
  const price = priceRaw != null && priceRaw !== "" ? Number(priceRaw) : NaN;
  if (!description || !Number.isFinite(price) || price < 0) return null;
  const code = str(row.code) ?? `ST-${String(row.id)}`;
  return { code: code.slice(0, 64), description: description.slice(0, 500), unit: "EA", price };
}

/** The vendor's default pricing contract id, if one exists — the context that makes
 *  GET /libitem return a price. Best-effort: none → prices fall back to item cost. */
async function defaultContractId(conn: ServicetradeConnection): Promise<string | null> {
  try {
    const data = await servicetradeFetch<{ contracts?: Record<string, unknown>[] }>(
      conn,
      `contract?vendorId=${conn.stCompanyId}`
    );
    const hit = arr(data?.contracts).find((c) => c.type === "default" && c.active !== false) ?? arr(data?.contracts)[0];
    return hit?.id != null ? String(hit.id) : null;
  } catch (err) {
    logger.warn("ServiceTrade default contract lookup failed; lib items price from cost", {
      companyId: conn.companyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function ingestLibItems(conn: ServicetradeConnection, companyId: number, since: number | null): Promise<number> {
  const book = await prisma.pricebook.upsert({
    where: { companyId_name: { companyId, name: SERVICETRADE_PRICEBOOK_NAME } },
    update: {},
    create: { companyId, name: SERVICETRADE_PRICEBOOK_NAME, priority: 9999, source: "SERVICETRADE" },
  });
  const contractId = await defaultContractId(conn);
  let projected = 0;
  await servicetradePageAll<{ libItems?: Record<string, unknown>[] }>(
    conn,
    `libitem?active=true${contractId ? `&contractId=${contractId}` : ""}${sinceParam(since)}`,
    async (data) => {
      const mapped = arr(data.libItems)
        .map((r) => ({ id: String(r.id), item: mapServicetradeLibItem(r) }))
        .filter((r): r is { id: string; item: NonNullable<typeof r.item> } => r.item != null);
      if (mapped.length === 0) return;
      // pricebook_items is unique on (company, code): a code an admin's own book owns is skipped,
      // never overwritten — their price wins the lookup anyway.
      const owned = await prisma.pricebookItem.findMany({
        where: { companyId, code: { in: mapped.map((m) => m.item.code) }, source: { not: "SERVICETRADE" } },
        select: { code: true },
      });
      const taken = new Set(owned.map((o) => o.code));
      for (const { id, item } of mapped) {
        if (taken.has(item.code)) continue;
        await prisma.pricebookItem.upsert({
          where: { companyId_code: { companyId, code: item.code } },
          update: { description: item.description, unit: item.unit, unitPrice: item.price, pricebookId: book.id, externalId: id },
          create: { companyId, code: item.code, description: item.description, unit: item.unit, unitPrice: item.price, pricebookId: book.id, source: "SERVICETRADE", externalId: id },
        });
        projected++;
      }
    }
  );
  return projected;
}

const normText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The ServiceTrade libItemId a quote line posts with: exact pricebook code first, then a single
 *  unambiguous name match, else null (a line with a description and no libItem is valid there). */
export async function servicetradeLibItemResolver(
  companyId: number
): Promise<(line: { description: string; pricebookCode: string | null }) => string | null> {
  const items = await prisma.pricebookItem.findMany({
    where: { companyId, source: "SERVICETRADE", externalId: { not: null } },
    select: { code: true, description: true, externalId: true },
  });
  const byCode = new Map(items.map((i) => [i.code, i.externalId!]));
  return (line) => {
    if (line.pricebookCode && byCode.has(line.pricebookCode)) return byCode.get(line.pricebookCode)!;
    const d = normText(line.description);
    if (!d) return null;
    const hits = items.filter((i) => {
      const n = normText(i.description);
      return n.length >= 6 && (d.includes(n) || n.includes(d));
    });
    return hits.length === 1 ? hits[0].externalId! : null;
  };
}

// ---------- tax groups ----------

/** combinedRate is a decimal (0.085) → percent (8.5), bounded to sales_tax's Decimal(6,4). */
export const taxGroupPercent = (row: Record<string, unknown>): number | null => {
  const rate = Number(row.combinedRate);
  if (!Number.isFinite(rate) || rate < 0 || rate >= 1) return null;
  return Math.round(rate * 100 * 10000) / 10000;
};

/** One tax group → a sales_tax row (source SERVICETRADE) + its link; returns the sales_tax id.
 *  Shared by the sync stage and quote seeding (a job's location can name a group not yet synced). */
async function upsertTaxGroup(companyId: number, row: Record<string, unknown>): Promise<{ id: number; percent: number } | null> {
  const stTaxGroupId = row.id != null ? String(row.id) : "";
  const percent = taxGroupPercent(row);
  if (!stTaxGroupId || percent == null) return null;
  const name = (str(row.name) ?? str(row.code) ?? `ServiceTrade ${percent}%`).slice(0, 120);
  const link = await prisma.salesTaxServicetrade.findUnique({
    where: { companyId_stTaxGroupId: { companyId, stTaxGroupId } },
    select: { salesTaxId: true },
  });
  if (link) {
    try {
      await prisma.salesTax.update({ where: { id: link.salesTaxId }, data: { name, ratePercent: percent } });
    } catch {
      await prisma.salesTax.update({ where: { id: link.salesTaxId }, data: { ratePercent: percent } });
    }
    await prisma.salesTaxServicetrade.update({
      where: { companyId_stTaxGroupId: { companyId, stTaxGroupId } },
      data: { raw: row as Prisma.InputJsonValue },
    });
    return { id: link.salesTaxId, percent };
  }
  const create = (n: string) =>
    prisma.salesTax.create({
      data: { companyId, name: n, ratePercent: percent, source: "SERVICETRADE", isDefault: false },
      select: { id: true },
    });
  let salesTaxId: number;
  try {
    salesTaxId = (await create(name)).id;
  } catch {
    salesTaxId = (await create(`${name.slice(0, 100)} (${stTaxGroupId})`)).id;
  }
  await prisma.salesTaxServicetrade.create({
    data: { salesTaxId, companyId, stTaxGroupId, raw: row as Prisma.InputJsonValue },
  });
  return { id: salesTaxId, percent };
}

async function ingestTaxGroups(conn: ServicetradeConnection, companyId: number): Promise<number> {
  let synced = 0;
  await servicetradePageAll<{ taxGroups?: Record<string, unknown>[] }>(conn, "taxgroup", async (data) => {
    for (const row of arr(data.taxGroups)) if (await upsertTaxGroup(companyId, row)) synced++;
  });
  return synced;
}

// ---------- reads for the Estimates tab ----------

export interface ServicetradeJobChoice {
  stJobId: string;
  number: string | null;
  name: string;
  description: string;
  status: string | null;
  customerName: string | null;
  locationName: string | null;
  openDeficiencyCount: number;
  stUpdatedAt: string | null;
}

/** Closed = reported fixed/invalid, or resolved out of the quoting lifecycle. */
const closedDeficiency = (status: string | null, resolution: string | null): boolean =>
  /^(fixed|invalid)$/i.test(status ?? "") || /^(fixed|invalid|rejected)$/i.test(resolution ?? "");

export const servicetradeJobRawFor = (companyId: number, stJobId: string) =>
  prisma.servicetradeJobRaw.findUnique({ where: { companyId_stJobId: { companyId, stJobId } } });

/** Open deficiencies for a job: reported ON the job, or (their model — deficiencies belong to a
 *  location) unresolved at the job's location. */
export async function openServicetradeDeficienciesFor(
  companyId: number,
  job: { stJobId: string; locationId: string | null }
) {
  const rows = await prisma.servicetradeDeficiencyRaw.findMany({
    where: {
      companyId,
      OR: [{ stJobId: job.stJobId }, ...(job.locationId ? [{ stLocationId: job.locationId }] : [])],
    },
    orderBy: { id: "asc" },
  });
  return rows.filter((r) => !closedDeficiency(r.status, r.resolution));
}

/** The bits of a raw job every reader wants. Pure; exported for the check script. */
export const jobBits = (raw: Record<string, unknown>) => {
  const location = obj(raw.location);
  const customer = obj(raw.customer);
  const services = arr(raw.serviceRequests);
  const scope = services.map((s) => str(s.description)).filter(Boolean) as string[];
  return {
    location,
    customer,
    locationId: idOf(location),
    customerId: idOf(customer),
    vendorId: idOf(raw.vendor),
    locationName: str(location?.name),
    locationAddress: addrText(location?.address),
    customerName: str(customer?.name),
    title: str(raw.customName) ?? str(raw.name) ?? "",
    description: [str(raw.description), ...scope].filter(Boolean).join("\n"),
    jobType: str(raw.type),
    serviceLineId: services.map((s) => (s.serviceLineId != null ? String(s.serviceLineId) : null)).find(Boolean) ?? null,
    number: raw.number != null ? String(raw.number) : null,
  };
};

export async function listServicetradeJobs(companyId: number, q?: string): Promise<ServicetradeJobChoice[]> {
  const rows = await prisma.servicetradeJobRaw.findMany({
    where: { companyId },
    orderBy: { stUpdatedAt: "desc" },
    take: 200,
  });
  const counts = await prisma.servicetradeDeficiencyRaw.groupBy({
    by: ["stJobId"],
    where: { companyId, stJobId: { in: rows.map((r) => r.stJobId) } },
    _count: { _all: true },
  });
  // ponytail: counts every deficiency on the job, not only open ones — the badge is a hint.
  const countByJob = new Map(counts.map((c) => [c.stJobId, c._count._all]));
  const needle = q?.trim().toLowerCase();
  const choices = rows.map((r) => {
    const b = jobBits(r.rawPayload as Record<string, unknown>);
    return {
      stJobId: r.stJobId,
      number: r.number,
      name: b.title,
      description: b.description,
      status: r.status,
      customerName: b.customerName,
      locationName: b.locationName ?? b.locationAddress,
      openDeficiencyCount: countByJob.get(r.stJobId) ?? 0,
      stUpdatedAt: r.stUpdatedAt?.toISOString() ?? null,
    };
  });
  if (!needle) return choices;
  return choices.filter((c) =>
    [c.number, c.name, c.description, c.customerName, c.locationName]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(needle))
  );
}

// ---------- quote seeding ----------

/**
 * Everything a new quote inherits from its ServiceTrade job — the ZenTrades seed shape:
 *  - the CLARA customer, adopted by ServiceTrade customer id first (customer_servicetrade),
 *    created from the embedded customer + location otherwise;
 *  - the tax snapshot from the job location's tax group (one GET /location — the job embed
 *    carries `taxable` but not the group), null → the create route falls back to the default;
 *  - the proposal template name-matched to the job type, else the agent asks.
 */
export async function seedQuoteFromServicetradeJob(companyId: number, stJobId: string): Promise<ZtQuoteSeed | null> {
  const raw = await servicetradeJobRawFor(companyId, stJobId);
  if (!raw) return null;
  const b = jobBits(raw.rawPayload as Record<string, unknown>);

  let customerId: number | null = null;
  if (b.customerId && b.customerName) {
    const link = await prisma.customerServicetrade.findUnique({
      where: { companyId_stCustomerId: { companyId, stCustomerId: b.customerId } },
      select: { customerId: true },
    });
    if (link) customerId = link.customerId;
    else {
      const addr = obj(b.location?.address);
      const created = await prisma.customer.create({
        data: {
          companyId,
          name: b.customerName,
          email: str(b.location?.email),
          phone: str(b.location?.phoneNumber),
          // ponytail: the service location's address stands in for billing — their /company
          // resource holds the billing address; fetch it if a client ever needs the split.
          address: b.locationAddress,
          addressLine1: str(addr?.street),
          city: str(addr?.city),
          state: str(addr?.state),
          postalCode: str(addr?.postalCode),
        },
      });
      await prisma.customerServicetrade.create({
        data: { customerId: created.id, companyId, stCustomerId: b.customerId, raw: b.customer as Prisma.InputJsonValue },
      });
      customerId = created.id;
    }
  }

  // -- tax snapshot from the location's tax group (best-effort; never fails the creation) --
  let salesTaxId: number | null = null;
  let taxRatePercent: number | null = null;
  if (b.locationId && b.location?.taxable !== false) {
    try {
      const conn = await servicetradeConnectionFor(companyId);
      if (servicetradeConnected(conn)) {
        const loc = await servicetradeFetch<Record<string, unknown>>(conn, `location/${b.locationId}`);
        const group = obj(loc?.taxGroup);
        const tax = group ? await upsertTaxGroup(companyId, group) : null;
        if (tax) {
          salesTaxId = tax.id;
          taxRatePercent = tax.percent;
        }
      }
    } catch (err) {
      logger.warn("ServiceTrade location tax lookup failed; quote seeds the company default", {
        companyId,
        stJobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const templateChoices = await listProposalTemplateChoices(companyId).catch(() => [] as { id: number; name: string }[]);
  const matched = b.jobType ? matchTemplateToJobType(templateChoices, b.jobType.replace(/_/g, " ")) : null;
  return {
    customerId,
    customerName: b.customerName ?? b.locationName,
    customerAddress: b.locationAddress ?? b.locationName,
    customerPhone: str(b.location?.phoneNumber),
    salesTaxId,
    taxRatePercent,
    proposalTemplateId: matched?.id ?? null,
    proposalTemplateName: matched?.name ?? null,
    jobType: b.jobType,
    templateChoices,
  };
}

export const deficiencyLine = (row: Record<string, unknown>): { headline: string; fix: string | null; severity: string | null; asset: string | null } => ({
  headline: str(row.description) ?? str(row.title) ?? "(unnamed deficiency)",
  fix: str(row.proposedFix),
  severity: str(row.severity),
  asset: str(obj(row.asset)?.name),
});

const fmtDeficiency = (row: Record<string, unknown>, bold: boolean) => {
  const l = deficiencyLine(row);
  return `- ${[
    l.severity ? (bold ? `**[${l.severity}]**` : `[${l.severity}]`) : null,
    l.headline,
    l.asset ? `(${l.asset})` : null,
    l.fix ? `— proposed fix: ${l.fix}` : null,
  ]
    .filter(Boolean)
    .join(" ")}`;
};

/** Deterministic first AI message for a ServiceTrade-seeded quote (ztWelcomeMessage's twin). */
export async function servicetradeWelcomeMessage(companyId: number, stJobId: string): Promise<string | null> {
  const raw = await servicetradeJobRawFor(companyId, stJobId);
  if (!raw) return null;
  const b = jobBits(raw.rawPayload as Record<string, unknown>);
  const defs = await openServicetradeDeficienciesFor(companyId, { stJobId, locationId: b.locationId });
  const site = b.locationName ?? b.locationAddress;
  const lines: string[] = [
    `This estimate is for **ServiceTrade job #${raw.number ?? raw.stJobId}** — ${b.title || b.description || "(no description)"}${
      site ? ` at ${site}` : ""
    }${b.customerName ? `, billed to ${b.customerName}` : ""}.`,
  ];
  if (b.description && b.description !== b.title) lines.push("", b.description);
  if (defs.length > 0) {
    lines.push("", `The job has **${defs.length} open deficienc${defs.length === 1 ? "y" : "ies"}**:`);
    for (const d of defs) lines.push(fmtDeficiency(d.rawPayload as Record<string, unknown>, true));
    lines.push("", "Tell me which of these to include — or say **cover all of them** and I'll propose the full scope.");
  } else {
    lines.push("", "No open deficiencies are recorded for this job. Describe the work and I'll build the estimate.");
  }
  return lines.join("\n");
}

const DEFICIENCY_HINT =
  "\nIf the technician asks to QUOTE THE DEFICIENCIES (a repair estimate), propose one line item per open " +
  "deficiency above — quantity 1 unless they say otherwise — and confirm before adding.";

/** The context block the estimating agent gets for a ServiceTrade-seeded quote (ztChatContext's twin). */
export async function servicetradeChatContext(companyId: number, stJobId: string): Promise<string | null> {
  const raw = await servicetradeJobRawFor(companyId, stJobId);
  if (!raw) return null;
  const b = jobBits(raw.rawPayload as Record<string, unknown>);
  const defs = await openServicetradeDeficienciesFor(companyId, { stJobId, locationId: b.locationId });
  const defLines = defs.map((d) => fmtDeficiency(d.rawPayload as Record<string, unknown>, false)).join("\n");
  return `THIS ESTIMATE IS FOR A SERVICETRADE JOB — treat the following as the job description the technician would otherwise dictate. Use it to propose scope; the technician confirms or refines. Never re-ask details stated here.
Job #${raw.number ?? raw.stJobId}${b.jobType ? ` (${b.jobType.replace(/_/g, " ")})` : ""}: ${b.title}${b.description && b.description !== b.title ? `\n${b.description}` : ""}
Customer: ${b.customerName ?? "unknown"} · Site: ${b.locationName ?? b.locationAddress ?? ""}
${defs.length > 0 ? `OPEN DEFICIENCIES (${defs.length}) — the likely scope of this estimate:\n${defLines}${DEFICIENCY_HINT}` : "No open deficiencies recorded for this job."}`;
}
