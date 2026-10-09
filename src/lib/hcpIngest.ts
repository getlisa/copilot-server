import { createHash } from "crypto";
import { Prisma, HcpConnection } from "@prisma/client";
import prisma from "./prisma";
import logger from "./logger";
import { setSyncProgress, clearSyncProgress } from "./syncProgress";
import { hcpConnectionFor, hcpConnected, hcpFetch, hcpPageAll } from "./hcp";
import { listProposalTemplateChoices, matchTemplateToJobType } from "./proposalTemplates";
import type { ZtQuoteSeed } from "./ztIngest";

/**
 * Housecall Pro sync engine — servicetradeIngest.ts structure, two stages:
 *  - jobs (GET /jobs sorted by updated_at desc; there is no updated_after filter, so the walk
 *    stops at the first page that is entirely older than the last COMPLETE run, 5-minute overlap);
 *  - price book: materials (walked category by category — GET /api/price_book/materials needs a
 *    material_category_uuid) and services (GET /api/price_book/services) → one "Housecall Pro
 *    catalog" pricebook (priority 9999, any admin book outranks it) so chat prices from their
 *    list and a quote line can post with its service_item_id.
 * No tax stage: Housecall Pro has no tax-rate API; tax is applied by the job inside HCP, and
 * CLARA's own (manual) rates stay in force. No deficiency stage: HCP has no such object; the
 * job's description and notes are the scope.
 * One sync at a time per company (sync_started_at claim); raw-first with a content hash;
 * Estimates-tab-only scope (nothing projects into `jobs`).
 */

export const HCP_SYNC_CLAIM_STALE_MS = 10 * 60 * 1000;

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
/** ISO-8601 → Date, null when absent/invalid. */
const ts = (v: unknown): Date | null => {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
/** Integer cents → dollars. */
const dollars = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v / 100 : null);

/** {street, street_line_2, city, state, zip} → one line. */
export const addrText = (v: unknown): string | null => {
  const a = obj(v);
  if (!a) return null;
  const parts = [a.street, a.street_line_2, a.city, a.state, a.zip].map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
};

export class HcpSyncRunningError extends Error {}

// ---------- the run ----------

export async function syncHcpData(companyId: number): Promise<{ jobs: number; items: number; errors: string[] }> {
  const conn = await hcpConnectionFor(companyId);
  if (!hcpConnected(conn)) throw new Error("Housecall Pro is not connected for this company");

  const claim = await prisma.hcpConnection.updateMany({
    where: {
      companyId,
      OR: [{ syncStartedAt: null }, { syncStartedAt: { lt: new Date(Date.now() - HCP_SYNC_CLAIM_STALE_MS) } }],
    },
    data: { syncStartedAt: new Date() },
  });
  if (claim.count === 0) {
    const mins = conn.syncStartedAt ? Math.round((Date.now() - conn.syncStartedAt.getTime()) / 60_000) : null;
    throw new HcpSyncRunningError(
      mins != null
        ? `A Housecall Pro sync is already running (started ${mins} min ago; a stalled run frees after 10)`
        : "A Housecall Pro sync is already running for this company"
    );
  }

  const since = conn.lastSyncAt ? new Date(conn.lastSyncAt.getTime() - 5 * 60_000) : null;
  const errors: string[] = [];
  const counts = { jobs: 0, items: 0 };
  try {
    const stages: [keyof typeof counts, Promise<number>][] = [
      ["jobs", ingestJobs(conn, companyId, since)],
      ["items", ingestPricebook(conn, companyId)],
    ];
    const results = await Promise.allSettled(stages.map(([, p]) => p));
    results.forEach((r, i) => {
      const name = stages[i][0];
      if (r.status === "fulfilled") counts[name] = r.value;
      else errors.push(`${name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    });
    await prisma.hcpConnection.update({
      where: { companyId },
      data: errors.length === 0 ? { lastSyncAt: new Date(), lastSyncError: null } : { lastSyncError: errors.join(" | ") },
    });
  } finally {
    clearSyncProgress("hcp", companyId);
    await prisma.hcpConnection.updateMany({ where: { companyId }, data: { syncStartedAt: null } });
  }
  logger.info("Housecall Pro sync finished", { companyId, ...counts, errors });
  return { ...counts, errors };
}

// ---------- jobs ----------

async function ingestJobs(conn: HcpConnection, companyId: number, since: Date | null): Promise<number> {
  let synced = 0;
  const setProgress = (msg: string) => setSyncProgress("hcp", companyId, "jobs", msg);
  setProgress("Jobs: fetching…");
  await hcpPageAll<{ jobs?: Record<string, unknown>[]; page?: number; total_pages?: number }>(
    conn,
    "jobs?sort_by=updated_at&sort_direction=desc&page_size=100",
    async (data) => {
      setProgress(`Jobs: page ${data.page ?? "?"}/${data.total_pages ?? "?"} — ${synced} updated…`);
      const all = arr(data.jobs);
      // Newest first: once a page holds nothing newer than `since`, every later page is older too.
      const fresh = since ? all.filter((row) => (ts(row.updated_at)?.getTime() ?? Infinity) >= since.getTime()) : all;
      const rows = fresh.filter((row) => row.id != null).map((row) => ({ id: String(row.id), row, contentHash: hash(row) }));
      if (rows.length > 0) {
        const existing = await prisma.hcpJobRaw.findMany({
          where: { companyId, hcpJobId: { in: rows.map((r) => r.id) } },
          select: { hcpJobId: true, contentHash: true },
        });
        const hashById = new Map(existing.map((e) => [e.hcpJobId, e.contentHash]));
        const changed = rows.filter((r) => hashById.get(r.id) !== r.contentHash);
        if (changed.length > 0) {
          await prisma.$executeRaw`
            INSERT INTO hcp_jobs_raw
              (company_id, hcp_job_id, invoice_number, work_status, hcp_updated_at, raw_payload, content_hash, created_at, updated_at)
            VALUES ${Prisma.join(
              changed.map(
                ({ id, row, contentHash }) =>
                  Prisma.sql`(${companyId}, ${id}, ${str(row.invoice_number)?.slice(0, 64) ?? null}, ${
                    str(row.work_status)?.slice(0, 32) ?? null
                  }, ${ts(row.updated_at)}, ${JSON.stringify(row)}::jsonb, ${contentHash}, now(), now())`
              )
            )}
            ON CONFLICT (company_id, hcp_job_id) DO UPDATE SET
              raw_payload    = EXCLUDED.raw_payload,
              content_hash   = EXCLUDED.content_hash,
              invoice_number = EXCLUDED.invoice_number,
              work_status    = EXCLUDED.work_status,
              hcp_updated_at = EXCLUDED.hcp_updated_at,
              updated_at     = now()
          `;
          synced += changed.length;
        }
      }
      return fresh.length === all.length; // a trimmed page = the incremental boundary; stop.
    }
  );
  setProgress(`Jobs: done (${synced} updated)`);
  return synced;
}

// ---------- price book ----------

export const HCP_PRICEBOOK_NAME = "Housecall Pro catalog";

/**
 * The service_item_type a quote line posts with (their LineItem enum: market_place |
 * organizational | pricebook_material). Materials are documented; VERIFY on a live account
 * that a price-book SERVICE posts as "organizational".
 */
export type HcpItemKind = "pricebook_material" | "organizational";

/** externalId on the synced pricebook row: "<service_item_type>:<uuid>", split at post time. */
export const hcpExternalId = (kind: HcpItemKind, uuid: string) => `${kind}:${uuid}`;

/** One material or service → PricebookItem fields, or null when unpriced. Prices are integer cents. */
export function mapHcpCatalogItem(
  row: Record<string, unknown>,
  kind: HcpItemKind
): { code: string; description: string; unit: string; price: number; externalId: string } | null {
  const uuid = str(row.uuid);
  const description = str(row.name);
  const price = dollars(row.price);
  if (!uuid || !description || price == null || price < 0) return null;
  const own = kind === "pricebook_material" ? str(row.part_number) : str(row.task_number);
  const code = own ?? `HCP-${kind === "pricebook_material" ? "M" : "S"}-${uuid.replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  return {
    code: code.slice(0, 64),
    description: description.slice(0, 500),
    unit: (str(row.unit_of_measure) ?? "EA").slice(0, 16),
    price,
    externalId: hcpExternalId(kind, uuid),
  };
}

/** Every material category uuid, root and nested (GET /api/price_book/material_categories). */
async function materialCategoryIds(conn: HcpConnection): Promise<string[]> {
  const ids: string[] = [];
  const walk = async (parent: string | null) => {
    const found: string[] = [];
    await hcpPageAll<{ data?: Record<string, unknown>[]; total_pages_count?: number }>(
      conn,
      `api/price_book/material_categories?page_size=100${parent ? `&parent_uuid=${encodeURIComponent(parent)}` : ""}`,
      async (data) => {
        for (const c of arr(data.data)) if (str(c.uuid)) found.push(String(c.uuid));
      }
    );
    for (const id of found) {
      ids.push(id);
      await walk(id);
    }
  };
  await walk(null);
  return ids;
}

async function ingestPricebook(conn: HcpConnection, companyId: number): Promise<number> {
  const book = await prisma.pricebook.upsert({
    where: { companyId_name: { companyId, name: HCP_PRICEBOOK_NAME } },
    update: {},
    create: { companyId, name: HCP_PRICEBOOK_NAME, priority: 9999, source: "HOUSECALL_PRO" },
  });
  let projected = 0;
  const setProgress = (msg: string) => setSyncProgress("hcp", companyId, "pricebook", msg);
  setProgress("Price book: listing categories…");
  const upsertPage = async (rows: Record<string, unknown>[], kind: HcpItemKind) => {
    const mapped = rows.map((r) => mapHcpCatalogItem(r, kind)).filter((m): m is NonNullable<typeof m> => m != null);
    if (mapped.length === 0) return;
    // pricebook_items is unique on (company, code): a code an admin's own book owns is skipped,
    // never overwritten — their price wins the lookup anyway.
    const owned = await prisma.pricebookItem.findMany({
      where: { companyId, code: { in: mapped.map((m) => m.code) }, source: { not: "HOUSECALL_PRO" } },
      select: { code: true },
    });
    const taken = new Set(owned.map((o) => o.code));
    for (const item of mapped) {
      if (taken.has(item.code)) continue;
      await prisma.pricebookItem.upsert({
        where: { companyId_code: { companyId, code: item.code } },
        update: { description: item.description, unit: item.unit, unitPrice: item.price, pricebookId: book.id, externalId: item.externalId },
        create: { companyId, code: item.code, description: item.description, unit: item.unit, unitPrice: item.price, pricebookId: book.id, source: "HOUSECALL_PRO", externalId: item.externalId },
      });
      projected++;
    }
  };
  const categories = await materialCategoryIds(conn);
  let categoriesDone = 0;
  for (const categoryId of categories) {
    setProgress(`Price book: materials, category ${++categoriesDone}/${categories.length} — ${projected} imported…`);
    await hcpPageAll<{ data?: Record<string, unknown>[]; total_pages_count?: number }>(
      conn,
      `api/price_book/materials?material_category_uuid=${encodeURIComponent(categoryId)}&page_size=100`,
      async (data) => upsertPage(arr(data.data), "pricebook_material")
    );
  }
  await hcpPageAll<{ data?: Record<string, unknown>[]; total_pages_count?: number; total_pages?: number }>(
    conn,
    "api/price_book/services?page_size=100",
    async (data) => {
      setProgress(`Price book: services — ${projected} imported…`);
      await upsertPage(arr(data.data), "organizational");
    }
  );
  setProgress(`Price book: done (${projected} items)`);
  return projected;
}

const normText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The service item a quote line posts with: exact pricebook code first, then a single
 *  unambiguous name match, else null (a free-text line is valid on an HCP job). */
export async function hcpServiceItemResolver(
  companyId: number
): Promise<(line: { description: string; pricebookCode: string | null }) => { id: string; type: HcpItemKind } | null> {
  const items = await prisma.pricebookItem.findMany({
    where: { companyId, source: "HOUSECALL_PRO", externalId: { not: null } },
    select: { code: true, description: true, externalId: true },
  });
  const split = (externalId: string): { id: string; type: HcpItemKind } | null => {
    const i = externalId.indexOf(":");
    return i > 0 ? { type: externalId.slice(0, i) as HcpItemKind, id: externalId.slice(i + 1) } : null;
  };
  const byCode = new Map(items.map((i) => [i.code, i.externalId!]));
  return (line) => {
    if (line.pricebookCode && byCode.has(line.pricebookCode)) return split(byCode.get(line.pricebookCode)!);
    const d = normText(line.description);
    if (!d) return null;
    const hits = items.filter((i) => {
      const n = normText(i.description);
      return n.length >= 6 && (d.includes(n) || n.includes(d));
    });
    return hits.length === 1 ? split(hits[0].externalId!) : null;
  };
}

// ---------- reads for the Estimates tab ----------

export interface HcpJobChoice {
  hcpJobId: string;
  invoiceNumber: string | null;
  name: string;
  description: string;
  status: string | null;
  customerName: string | null;
  addressLine: string | null;
  scheduledStart: string | null;
  hcpUpdatedAt: string | null;
}

export const hcpJobRawFor = (companyId: number, hcpJobId: string) =>
  prisma.hcpJobRaw.findUnique({ where: { companyId_hcpJobId: { companyId, hcpJobId } } });

/** The bits of a raw job every reader wants. Pure; exported for the check script. */
export const jobBits = (raw: Record<string, unknown>) => {
  const customer = obj(raw.customer);
  const address = obj(raw.address);
  const person = [str(customer?.first_name), str(customer?.last_name)].filter(Boolean).join(" ");
  const notes = arr(raw.notes).map((n) => str(n.content)).filter(Boolean) as string[];
  const description = str(raw.description) ?? "";
  return {
    customer,
    address,
    customerId: customer?.id != null ? String(customer.id) : null,
    customerName: str(customer?.company) ?? (person || null),
    customerEmail: str(customer?.email),
    customerPhone: str(customer?.mobile_number) ?? str(customer?.home_number) ?? str(customer?.work_number),
    addressLine: addrText(address),
    title: description.split("\n")[0].slice(0, 200),
    description,
    notes,
    jobType: str(obj(obj(raw.job_fields)?.job_type)?.name),
    invoiceNumber: str(raw.invoice_number),
    workStatus: str(raw.work_status),
    scheduledStart: str(obj(raw.schedule)?.scheduled_start),
  };
};

const CANCELED = /canceled/i;

export async function listHcpJobs(companyId: number, q?: string): Promise<HcpJobChoice[]> {
  const rows = await prisma.hcpJobRaw.findMany({
    where: { companyId },
    orderBy: { hcpUpdatedAt: "desc" },
    take: 250,
  });
  const needle = q?.trim().toLowerCase();
  const choices = rows
    .filter((r) => !CANCELED.test(r.workStatus ?? ""))
    .slice(0, 200)
    .map((r) => {
      const b = jobBits(r.rawPayload as Record<string, unknown>);
      return {
        hcpJobId: r.hcpJobId,
        invoiceNumber: r.invoiceNumber,
        name: b.title,
        description: b.description,
        status: r.workStatus,
        customerName: b.customerName,
        addressLine: b.addressLine,
        scheduledStart: b.scheduledStart,
        hcpUpdatedAt: r.hcpUpdatedAt?.toISOString() ?? null,
      };
    });
  if (!needle) return choices;
  return choices.filter((c) =>
    [c.invoiceNumber, c.name, c.description, c.customerName, c.addressLine]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(needle))
  );
}

// ---------- quote seeding ----------

/**
 * Everything a new quote inherits from its Housecall Pro job — the ZenTrades seed shape:
 *  - the CLARA customer, adopted by HCP customer id first (customer_hcp), created from the
 *    embedded customer + service address otherwise;
 *  - NO tax snapshot (HCP exposes no rates) → the create route applies the company default;
 *  - the proposal template name-matched to the job type, else the agent asks.
 */
export async function seedQuoteFromHcpJob(companyId: number, hcpJobId: string): Promise<ZtQuoteSeed | null> {
  const raw = await hcpJobRawFor(companyId, hcpJobId);
  if (!raw) return null;
  const b = jobBits(raw.rawPayload as Record<string, unknown>);

  let customerId: number | null = null;
  if (b.customerId && b.customerName) {
    const link = await prisma.customerHcp.findUnique({
      where: { companyId_hcpCustomerId: { companyId, hcpCustomerId: b.customerId } },
      select: { customerId: true },
    });
    if (link) customerId = link.customerId;
    else {
      const created = await prisma.customer.create({
        data: {
          companyId,
          name: b.customerName,
          email: b.customerEmail,
          phone: b.customerPhone,
          // ponytail: the job's service address stands in for billing — a customer's billing
          // address is a separate GET /customers/{id}/addresses; fetch it if a client needs the split.
          address: b.addressLine,
          addressLine1: [str(b.address?.street), str(b.address?.street_line_2)].filter(Boolean).join(", ") || null,
          city: str(b.address?.city),
          state: str(b.address?.state),
          postalCode: str(b.address?.zip),
        },
      });
      await prisma.customerHcp.create({
        data: { customerId: created.id, companyId, hcpCustomerId: b.customerId, raw: b.customer as Prisma.InputJsonValue },
      });
      customerId = created.id;
    }
  }

  const templateChoices = await listProposalTemplateChoices(companyId).catch(() => [] as { id: number; name: string }[]);
  const matched = b.jobType ? matchTemplateToJobType(templateChoices, b.jobType) : null;
  return {
    customerId,
    customerName: b.customerName,
    customerAddress: b.addressLine,
    customerPhone: b.customerPhone,
    salesTaxId: null,
    taxRatePercent: null,
    proposalTemplateId: matched?.id ?? null,
    proposalTemplateName: matched?.name ?? null,
    jobType: b.jobType,
    templateChoices,
  };
}

const jobLabel = (raw: { invoiceNumber: string | null; hcpJobId: string }) =>
  raw.invoiceNumber ? `#${raw.invoiceNumber}` : raw.hcpJobId;

/** Deterministic first AI message for an HCP-seeded quote (ztWelcomeMessage's twin). */
export async function hcpWelcomeMessage(companyId: number, hcpJobId: string): Promise<string | null> {
  const raw = await hcpJobRawFor(companyId, hcpJobId);
  if (!raw) return null;
  const b = jobBits(raw.rawPayload as Record<string, unknown>);
  const lines: string[] = [
    `This estimate is for **Housecall Pro job ${jobLabel(raw)}** — ${b.title || "(no description)"}${
      b.addressLine ? ` at ${b.addressLine}` : ""
    }${b.customerName ? `, for ${b.customerName}` : ""}${
      b.scheduledStart ? `, scheduled ${new Date(b.scheduledStart).toLocaleDateString("en-US")}` : ""
    }.`,
  ];
  if (b.description && b.description !== b.title) lines.push("", b.description);
  if (b.notes.length > 0) {
    lines.push("", "Job notes:");
    for (const n of b.notes) lines.push(`- ${n}`);
  }
  lines.push("", "Describe the work (or confirm the scope above) and I'll build the estimate. When you complete it, it is created as an estimate in Housecall Pro for this job's customer.");
  return lines.join("\n");
}

/** The context block the estimating agent gets for an HCP-seeded quote (ztChatContext's twin). */
export async function hcpChatContext(companyId: number, hcpJobId: string): Promise<string | null> {
  const raw = await hcpJobRawFor(companyId, hcpJobId);
  if (!raw) return null;
  const b = jobBits(raw.rawPayload as Record<string, unknown>);
  return `THIS ESTIMATE IS FOR A HOUSECALL PRO JOB — treat the following as the job description the technician would otherwise dictate. Use it to propose scope; the technician confirms or refines. Never re-ask details stated here.
Job ${jobLabel(raw)}${b.jobType ? ` (${b.jobType})` : ""}${b.workStatus ? ` · status: ${b.workStatus}` : ""}: ${b.description || "(no description)"}
Customer: ${b.customerName ?? "unknown"} · Service address: ${b.addressLine ?? "unknown"}
${b.notes.length > 0 ? `JOB NOTES:\n${b.notes.map((n) => `- ${n}`).join("\n")}` : "No job notes recorded."}
On completion the estimate is created in Housecall Pro's Estimates tab for this job's customer and service address.`;
}
