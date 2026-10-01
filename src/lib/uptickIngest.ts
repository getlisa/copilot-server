import { createHash } from "crypto";
import { Prisma, UptickConnection } from "@prisma/client";
import prisma from "./prisma";
import logger from "./logger";
import {
  uptickConnectionFor,
  uptickConnected,
  uptickFetch,
  jaRows,
  jaFlatten,
  jaIncluded,
  jaResolve,
  jaRelId,
  UptickApiError,
  type JaBody,
} from "./uptick";
import { listProposalTemplateChoices } from "./proposalTemplates";
import type { ZtQuoteSeed } from "./ztIngest";

/**
 * Uptick sync engine — ztIngest.ts structure, two stages (tasks = jobs, remarks = defects):
 *  - one sync at a time per company (sync_started_at row claim);
 *  - raw-first: the flattened JSON:API resource lands in uptick_*_raw with a content hash;
 *  - incremental via Uptick's `updatedsince` filter from the last COMPLETE run (5-minute overlap),
 *    full pull on the first sync;
 *  - Estimates-tab-only scope: nothing projects into `jobs`.
 *
 * VERIFY-ON-TENANT: field/relationship names come from Uptick's public connector manifest
 * (v2.15 lists) — the tenant runs v2.8. Marked VERIFY where the code guesses a name.
 *  - products project into one "Uptick catalog" pricebook (priority 9999 — any admin book
 *    outranks it), so chat prices from Uptick's list AND every defect-quote line can carry the
 *    product Uptick requires (a line without one shows "no product found" in their UI).
 * ponytail: no tax ingest — Uptick is flat GST; the company default sales tax applies.
 */

export const UPTICK_SYNC_CLAIM_STALE_MS = 10 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 200;

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Uptick addresses are a string in older versions and a structured blob since v2.14. */
export const addrText = (v: unknown): string | null => {
  if (typeof v === "string") return str(v);
  const a = obj(v);
  if (!a) return null;
  const parts = [
    a.line1 ?? a.address_line1 ?? a.street ?? a.address,
    a.line2 ?? a.address_line2,
    a.suburb ?? a.city ?? a.locality,
    a.state ?? a.region,
    a.postcode ?? a.postal_code ?? a.zipcode,
  ]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
};

/** Relationship id out of a stored (flattened) raw payload. */
const rawRelId = (raw: Record<string, unknown>, name: string): string | null => {
  const rels = obj(raw.relationships);
  const d = obj(obj(rels?.[name])?.data);
  return d?.id != null ? String(d.id) : null;
};

export class UptickSyncRunningError extends Error {}

// ---------- the run ----------

export async function syncUptickData(
  companyId: number
): Promise<{ tasks: number; remarks: number; products: number; errors: string[] }> {
  const conn = await uptickConnectionFor(companyId);
  if (!uptickConnected(conn)) throw new Error("Uptick is not connected for this company");

  const claim = await prisma.uptickConnection.updateMany({
    where: {
      companyId,
      OR: [
        { syncStartedAt: null },
        { syncStartedAt: { lt: new Date(Date.now() - UPTICK_SYNC_CLAIM_STALE_MS) } },
      ],
    },
    data: { syncStartedAt: new Date() },
  });
  if (claim.count === 0) {
    const mins = conn.syncStartedAt ? Math.round((Date.now() - conn.syncStartedAt.getTime()) / 60_000) : null;
    throw new UptickSyncRunningError(
      mins != null
        ? `An Uptick sync is already running (started ${mins} min ago; a stalled run frees after 10)`
        : "An Uptick sync is already running for this company"
    );
  }

  // Incremental from the last complete run with a 5-minute overlap (their clock vs ours).
  const since = conn.lastSyncAt ? new Date(conn.lastSyncAt.getTime() - 5 * 60_000).toISOString() : null;
  const errors: string[] = [];
  let tasks = 0;
  let remarks = 0;
  let products = 0;
  try {
    const [tR, rR, pR] = await Promise.allSettled([
      ingestTasks(conn, companyId, since),
      ingestRemarks(conn, companyId, since),
      ingestProducts(conn, companyId, since),
    ]);
    if (tR.status === "fulfilled") tasks = tR.value;
    else errors.push(`tasks: ${tR.reason instanceof Error ? tR.reason.message : String(tR.reason)}`);
    if (rR.status === "fulfilled") remarks = rR.value;
    else errors.push(`remarks: ${rR.reason instanceof Error ? rR.reason.message : String(rR.reason)}`);
    if (pR.status === "fulfilled") products = pR.value;
    else errors.push(`products: ${pR.reason instanceof Error ? pR.reason.message : String(pR.reason)}`);
    await prisma.uptickConnection.update({
      where: { companyId },
      data: errors.length === 0 ? { lastSyncAt: new Date(), lastSyncError: null } : { lastSyncError: errors.join(" | ") },
    });
  } finally {
    await prisma.uptickConnection.updateMany({ where: { companyId }, data: { syncStartedAt: null } });
  }
  logger.info("Uptick sync finished", { companyId, tasks, remarks, products, errors });
  return { tasks, remarks, products, errors };
}

/** Walk a JSON:API list via links.next (absolute URLs — uptickFetch passes them through). */
async function pageAll(
  conn: UptickConnection,
  firstPath: string,
  onPage: (body: JaBody) => Promise<void>
): Promise<void> {
  let path: string = firstPath;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await uptickFetch(conn, path);
    if (!body) return;
    await onPage(body);
    const next = body.links?.next;
    if (!next) return;
    path = next;
  }
}

// ---------- tasks (jobs) ----------

async function ingestTasks(conn: UptickConnection, companyId: number, since: string | null): Promise<number> {
  let synced = 0;
  const base = `tasks/?page[limit]=${PAGE_SIZE}&ordering=-updated${since ? `&updatedsince=${encodeURIComponent(since)}` : ""}`;
  const upsertPage = async (body: JaBody) => {
    const included = jaIncluded(body);
    const rows = jaRows(body).map((r) => {
      const flat = jaFlatten(r);
      // Embedded for the picker/seed; null when the include was refused (see the fallback).
      flat.property = jaResolve(r, "property", included);
      flat.client = jaResolve(r, "client", included);
      return { id: String(r.id), row: flat };
    });
    if (rows.length === 0) return;
    const existing = await prisma.uptickTaskRaw.findMany({
      where: { companyId, uptickTaskId: { in: rows.map((r) => r.id) } },
      select: { uptickTaskId: true, contentHash: true },
    });
    const hashById = new Map(existing.map((e) => [e.uptickTaskId, e.contentHash]));
    const changed = rows
      .map(({ id, row }) => ({ id, row, contentHash: hash(row) }))
      .filter((r) => hashById.get(r.id) !== r.contentHash);
    if (changed.length === 0) return;
    // One bulk statement per page (pool-of-1 friendly — see ztIngest's upsertPage).
    await prisma.$executeRaw`
      INSERT INTO uptick_tasks_raw
        (company_id, uptick_task_id, ref, status, uptick_updated_at, raw_payload, content_hash, created_at, updated_at)
      VALUES ${Prisma.join(
        changed.map(
          ({ id, row, contentHash }) =>
            Prisma.sql`(${companyId}, ${id}, ${str(row.ref)}, ${str(row.status)?.slice(0, 64) ?? null}, ${
              typeof row.updated === "string" ? new Date(row.updated) : null
            }, ${JSON.stringify(row)}::jsonb, ${contentHash}, now(), now())`
        )
      )}
      ON CONFLICT (company_id, uptick_task_id) DO UPDATE SET
        raw_payload       = EXCLUDED.raw_payload,
        content_hash      = EXCLUDED.content_hash,
        ref               = EXCLUDED.ref,
        status            = EXCLUDED.status,
        uptick_updated_at = EXCLUDED.uptick_updated_at,
        updated_at        = now()
    `;
    synced += changed.length;
  };
  try {
    // VERIFY: `include=property,client` — both are Task relationships in the v2.15 field list.
    await pageAll(conn, `${base}&include=property,client`, upsertPage);
  } catch (err) {
    // A refused include is a 400 on the FIRST page; fall back to the bare list so jobs still
    // land (the seed then fetches the client on demand).
    if (!(err instanceof UptickApiError && err.status === 400 && synced === 0)) throw err;
    logger.warn("Uptick refused include=property,client; syncing tasks without embeds", {
      companyId,
      error: err.message,
    });
    await pageAll(conn, base, upsertPage);
  }
  return synced;
}

// ---------- remarks (defects) ----------

async function ingestRemarks(conn: UptickConnection, companyId: number, since: string | null): Promise<number> {
  let synced = 0;
  const path = `remarks/?page[limit]=${PAGE_SIZE}&ordering=-updated${since ? `&updatedsince=${encodeURIComponent(since)}` : ""}`;
  await pageAll(conn, path, async (body) => {
    const rows = jaRows(body).map((r) => ({
      id: String(r.id),
      row: jaFlatten(r),
      // VERIFY: the relationship that names the task a remark was raised on. `task` is the
      // natural JSON:API name; the connector's field list only exposed asset/type. A remark with
      // neither task nor property link still lands raw — only the open-remark lookup misses it.
      taskId: jaRelId(r, "task") ?? jaRelId(r, "identified_task") ?? jaRelId(r, "servicetask"),
      propertyId: jaRelId(r, "property"),
    }));
    if (rows.length === 0) return;
    const existing = await prisma.uptickRemarkRaw.findMany({
      where: { companyId, uptickRemarkId: { in: rows.map((r) => r.id) } },
      select: { uptickRemarkId: true, contentHash: true },
    });
    const hashById = new Map(existing.map((e) => [e.uptickRemarkId, e.contentHash]));
    const changed = rows
      .map((r) => ({ ...r, contentHash: hash(r.row) }))
      .filter((r) => hashById.get(r.id) !== r.contentHash);
    if (changed.length === 0) return;
    await prisma.$executeRaw`
      INSERT INTO uptick_remarks_raw
        (company_id, uptick_remark_id, uptick_task_id, uptick_property_id, status, raw_payload, content_hash, created_at, updated_at)
      VALUES ${Prisma.join(
        changed.map(
          ({ id, row, taskId, propertyId, contentHash }) =>
            Prisma.sql`(${companyId}, ${id}, ${taskId}, ${propertyId}, ${str(row.status)?.slice(0, 64) ?? null}, ${JSON.stringify(
              row
            )}::jsonb, ${contentHash}, now(), now())`
        )
      )}
      ON CONFLICT (company_id, uptick_remark_id) DO UPDATE SET
        raw_payload        = EXCLUDED.raw_payload,
        content_hash       = EXCLUDED.content_hash,
        uptick_task_id     = EXCLUDED.uptick_task_id,
        uptick_property_id = EXCLUDED.uptick_property_id,
        status             = EXCLUDED.status,
        updated_at         = now()
    `;
    synced += changed.length;
  });
  return synced;
}

// ---------- products (pricebook) ----------

export const UPTICK_PRICEBOOK_NAME = "Uptick catalog";

/** One Uptick product → PricebookItem fields, or null when unpriced/inactive. Pure; exported
 *  for the check script. Field names from the v2.15 Product list (name, code, sku, unit_price,
 *  current_price, unit_description, is_active, deleted). */
export function mapUptickProduct(
  row: Record<string, unknown>
): { code: string; description: string; unit: string; price: number } | null {
  if (row.is_active === false || row.deleted === true) return null;
  const description = str(row.name) ?? str(row.description) ?? str(row.autocomplete_label);
  const priceRaw = row.unit_price ?? row.current_price;
  const price = priceRaw != null && priceRaw !== "" ? Number(priceRaw) : NaN;
  if (!description || !Number.isFinite(price)) return null;
  const code = str(row.code) ?? str(row.sku) ?? `UP-${String(row.id)}`;
  return { code: code.slice(0, 64), description: description.slice(0, 500), unit: str(row.unit_description)?.slice(0, 16) ?? "EA", price };
}

/**
 * Products straight into the company's "Uptick catalog" pricebook — no raw table (ponytail:
 * the mapping is four fields; add uptick_products_raw if a re-projection is ever needed).
 * pricebook_items is unique on (company, code): a code an admin's own book owns is skipped,
 * never overwritten — their price wins the lookup anyway (ZenTrades' rule).
 */
async function ingestProducts(conn: UptickConnection, companyId: number, since: string | null): Promise<number> {
  const book = await prisma.pricebook.upsert({
    where: { companyId_name: { companyId, name: UPTICK_PRICEBOOK_NAME } },
    update: {},
    create: { companyId, name: UPTICK_PRICEBOOK_NAME, priority: 9999, source: "UPTICK" },
  });
  let projected = 0;
  await pageAll(
    conn,
    `products/?page[limit]=${PAGE_SIZE}&ordering=-updated${since ? `&updatedsince=${encodeURIComponent(since)}` : ""}`,
    async (body) => {
      const rows = jaRows(body).map((r) => ({ id: String(r.id), item: mapUptickProduct(jaFlatten(r)) }));
      const mapped = rows.filter((r): r is { id: string; item: NonNullable<typeof r.item> } => r.item != null);
      if (mapped.length === 0) return;
      const owned = await prisma.pricebookItem.findMany({
        where: { companyId, code: { in: mapped.map((m) => m.item.code) }, source: { not: "UPTICK" } },
        select: { code: true },
      });
      const taken = new Set(owned.map((o) => o.code));
      for (const { id, item } of mapped) {
        if (taken.has(item.code)) continue;
        await prisma.pricebookItem.upsert({
          where: { companyId_code: { companyId, code: item.code } },
          update: { description: item.description, unit: item.unit, unitPrice: item.price, pricebookId: book.id, externalId: id },
          create: { companyId, code: item.code, description: item.description, unit: item.unit, unitPrice: item.price, pricebookId: book.id, source: "UPTICK", externalId: id },
        });
        projected++;
      }
    }
  );
  return projected;
}

const normText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The Uptick product id a quote line posts with. Exact pricebook code first (the line was
 * priced from the synced catalog), then a single unambiguous name match, then the company's
 * generic product (Miscellaneous / Labour / Other / Sundries) so the line is never product-less
 * in Uptick's UI. Null only when the catalog has nothing usable.
 * ponytail: the generic fallback is a name regex; add a per-company default-product setting if
 * a client's catalog names it differently.
 */
export async function uptickProductResolver(
  companyId: number
): Promise<(line: { description: string; pricebookCode: string | null; isLabor?: boolean }) => string | null> {
  const items = await prisma.pricebookItem.findMany({
    where: { companyId, source: "UPTICK", externalId: { not: null } },
    select: { code: true, description: true, externalId: true },
  });
  const byCode = new Map(items.map((i) => [i.code, i.externalId!]));
  const generic = (re: RegExp) => items.find((i) => re.test(i.description))?.externalId ?? null;
  const labourId = generic(/labou?r|service call|call ?out|technician/i);
  const miscId = generic(/misc|sundr|general|other|adhoc|ad-hoc/i) ?? labourId;
  return (line) => {
    if (line.pricebookCode && byCode.has(line.pricebookCode)) return byCode.get(line.pricebookCode)!;
    const d = normText(line.description);
    if (d) {
      const hits = items.filter((i) => {
        const n = normText(i.description);
        return n.length >= 6 && (d.includes(n) || n.includes(d));
      });
      if (hits.length === 1) return hits[0].externalId!;
    }
    return (line.isLabor ? labourId : null) ?? miscId ?? labourId;
  };
}

// ---------- reads for the Estimates tab ----------

export interface UptickJobChoice {
  uptickTaskId: string;
  ref: string | null;
  name: string;
  description: string;
  status: string | null;
  customerName: string | null;
  propertyName: string | null;
  openRemarkCount: number;
  uptickUpdatedAt: string | null;
}

const closedRemark = (status: string | null, row: Record<string, unknown>): boolean =>
  row.is_active === false ||
  row.deleted === true ||
  (!!status && /resolv|clos|complet|cancel|reject/i.test(status));

/** Open remarks for a task: raised ON the task, or (Uptick's own model — defect quotes are per
 *  property) unresolved at the task's property. ponytail: remarks already on a submitted defect
 *  quote are not excluded; add a quote_status filter once its values are seen on the tenant. */
export async function openUptickRemarksFor(
  companyId: number,
  task: { uptickTaskId: string; propertyId: string | null }
) {
  const rows = await prisma.uptickRemarkRaw.findMany({
    where: {
      companyId,
      OR: [
        { uptickTaskId: task.uptickTaskId },
        ...(task.propertyId ? [{ uptickPropertyId: task.propertyId }] : []),
      ],
    },
    orderBy: { id: "asc" },
  });
  return rows.filter((r) => !closedRemark(r.status, r.rawPayload as Record<string, unknown>));
}

export const uptickTaskRawFor = (companyId: number, uptickTaskId: string) =>
  prisma.uptickTaskRaw.findUnique({ where: { companyId_uptickTaskId: { companyId, uptickTaskId } } });

const taskBits = (raw: Record<string, unknown>) => {
  const property = obj(raw.property);
  const client = obj(raw.client);
  return {
    property,
    client,
    propertyId: rawRelId(raw, "property"),
    clientId: rawRelId(raw, "client") ?? (property ? rawRelId(property, "client") : null),
    propertyName: str(property?.name) ?? addrText(property?.address) ?? addrText(raw.address),
    clientName: str(client?.name),
    title: str(raw.name) ?? str(raw.description) ?? "",
    description: [str(raw.description), str(raw.scope_of_works)].filter(Boolean).join("\n"),
  };
};

export async function listUptickJobs(companyId: number, q?: string): Promise<UptickJobChoice[]> {
  const rows = await prisma.uptickTaskRaw.findMany({
    where: { companyId },
    orderBy: { uptickUpdatedAt: "desc" },
    take: 200,
  });
  const counts = await prisma.uptickRemarkRaw.groupBy({
    by: ["uptickTaskId"],
    where: { companyId, uptickTaskId: { in: rows.map((r) => r.uptickTaskId) } },
    _count: { _all: true },
  });
  // ponytail: counts every remark on the task, not only open ones — the picker badge is a hint,
  // the seed filters properly.
  const countByTask = new Map(counts.map((c) => [c.uptickTaskId, c._count._all]));
  const needle = q?.trim().toLowerCase();
  const choices = rows.map((r) => {
    const raw = r.rawPayload as Record<string, unknown>;
    const b = taskBits(raw);
    return {
      uptickTaskId: r.uptickTaskId,
      ref: r.ref,
      name: b.title,
      description: b.description,
      status: r.status,
      customerName: b.clientName,
      propertyName: b.propertyName,
      openRemarkCount: countByTask.get(r.uptickTaskId) ?? 0,
      uptickUpdatedAt: r.uptickUpdatedAt?.toISOString() ?? null,
    };
  });
  if (!needle) return choices;
  return choices.filter((c) =>
    [c.ref, c.name, c.description, c.customerName, c.propertyName]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(needle))
  );
}

// ---------- quote seeding ----------

/**
 * Everything a new quote inherits from its Uptick task — the ZenTrades seed shape so the create
 * route treats both the same:
 *  - the CLARA customer, adopted by Uptick client id first (customer_uptick), created from the
 *    embedded client otherwise;
 *  - NO tax snapshot (null → the create route falls back to the company default);
 *  - NO template auto-pick (Uptick's task category is an id only) → the agent asks.
 */
export async function seedQuoteFromUptickTask(companyId: number, uptickTaskId: string): Promise<ZtQuoteSeed | null> {
  const raw = await uptickTaskRawFor(companyId, uptickTaskId);
  if (!raw) return null;
  const b = taskBits(raw.rawPayload as Record<string, unknown>);

  let customerId: number | null = null;
  if (b.clientId && b.clientName) {
    const link = await prisma.customerUptick.findUnique({
      where: { companyId_uptickClientId: { companyId, uptickClientId: b.clientId } },
      select: { customerId: true },
    });
    if (link) customerId = link.customerId;
    else {
      const c = b.client!;
      const billing = c.billing_address ?? c.address ?? c.contact_address;
      const created = await prisma.customer.create({
        data: {
          companyId,
          name: b.clientName,
          email: str(c.billing_email_to) ?? str(c.contact_email),
          phone: str(c.contact_phone_bh) ?? str(c.contact_mobile),
          address: addrText(billing),
          ...(obj(billing)
            ? {
                addressLine1: str(obj(billing)!.line1 ?? obj(billing)!.street),
                city: str(obj(billing)!.suburb ?? obj(billing)!.city),
                state: str(obj(billing)!.state),
                postalCode: str(obj(billing)!.postcode ?? obj(billing)!.postal_code),
                country: str(obj(billing)!.country),
              }
            : {}),
        },
      });
      await prisma.customerUptick.create({
        data: { customerId: created.id, companyId, uptickClientId: b.clientId, raw: c as Prisma.InputJsonValue },
      });
      customerId = created.id;
    }
  }

  const templateChoices = await listProposalTemplateChoices(companyId).catch(() => [] as { id: number; name: string }[]);
  return {
    customerId,
    customerName: b.clientName ?? b.propertyName,
    customerAddress: b.propertyName,
    customerPhone: str(b.client?.contact_phone_bh) ?? str(b.client?.contact_mobile),
    salesTaxId: null,
    taxRatePercent: null,
    proposalTemplateId: null,
    proposalTemplateName: null,
    jobType: null,
    templateChoices,
  };
}

const remarkLine = (row: Record<string, unknown>): { headline: string; fix: string | null; severity: string | null; location: string | null } => ({
  headline: str(row.description) ?? str(row.notes) ?? "(unnamed defect)",
  fix: str(row.resolution),
  severity: row.severity != null && row.severity !== "" ? String(row.severity) : null,
  location: str(row.location),
});

/** One line item per open remark — the repair estimate. Unpriced: no Uptick catalog is ingested. */
export async function seedUptickRemarkLineItems(companyId: number, uptickTaskId: string, quoteId: string): Promise<number> {
  const raw = await uptickTaskRawFor(companyId, uptickTaskId);
  if (!raw) return 0;
  const b = taskBits(raw.rawPayload as Record<string, unknown>);
  const remarks = await openUptickRemarksFor(companyId, { uptickTaskId, propertyId: b.propertyId });
  let sort = 0;
  for (const r of remarks) {
    const l = remarkLine(r.rawPayload as Record<string, unknown>);
    await prisma.quoteLineItem.create({
      data: {
        quoteId,
        description: (l.fix ?? l.headline).slice(0, 500),
        quantity: 1,
        unit: "EA",
        unitPrice: null,
        isLabor: false,
        sortOrder: sort++,
      },
    });
  }
  return remarks.length;
}

export async function uptickProposalFacts(
  companyId: number,
  uptickTaskId: string
): Promise<{ facility: string | null; contactName: string | null; jobType: string | null; workType: string | null }> {
  const empty = { facility: null, contactName: null, jobType: null, workType: null };
  const raw = await uptickTaskRawFor(companyId, uptickTaskId).catch(() => null);
  if (!raw) return empty;
  const b = taskBits(raw.rawPayload as Record<string, unknown>);
  return {
    facility: b.propertyName,
    contactName: str(b.client?.contact_name) ?? b.clientName,
    jobType: null,
    workType: null,
  };
}

/** Deterministic first AI message for an Uptick-seeded quote (ztWelcomeMessage's twin). */
export async function uptickWelcomeMessage(companyId: number, uptickTaskId: string): Promise<string | null> {
  const raw = await uptickTaskRawFor(companyId, uptickTaskId);
  if (!raw) return null;
  const b = taskBits(raw.rawPayload as Record<string, unknown>);
  const remarks = await openUptickRemarksFor(companyId, { uptickTaskId, propertyId: b.propertyId });
  const lines: string[] = [
    `This estimate is for **Uptick job ${raw.ref ?? raw.uptickTaskId}** — ${b.title || b.description || "(no description)"}${
      b.propertyName ? ` at ${b.propertyName}` : ""
    }${b.clientName ? `, billed to ${b.clientName}` : ""}.`,
  ];
  if (b.description && b.description !== b.title) lines.push("", b.description);
  if (remarks.length > 0) {
    lines.push("", `The job has **${remarks.length} open defect${remarks.length === 1 ? "" : "s"}**:`);
    for (const r of remarks) {
      const l = remarkLine(r.rawPayload as Record<string, unknown>);
      lines.push(
        `- ${[l.severity ? `**[severity ${l.severity}]**` : null, l.headline, l.location ? `(${l.location})` : null, l.fix ? `— recommended: ${l.fix}` : null]
          .filter(Boolean)
          .join(" ")}`
      );
    }
    lines.push("", "Tell me which of these to include — or say **cover all of them** and I'll propose the full scope.");
  } else {
    lines.push("", "No open defects are recorded for this job. Describe the work and I'll build the estimate.");
  }
  return lines.join("\n");
}

const REMARK_HINT =
  "\nIf the technician asks to QUOTE THE DEFECTS (a repair estimate), propose one line item per open " +
  "defect above — quantity 1 unless they say otherwise — and confirm before adding.";

/** The context block the estimating agent gets for an Uptick-seeded quote (ztChatContext's twin). */
export async function uptickChatContext(companyId: number, uptickTaskId: string): Promise<string | null> {
  const raw = await uptickTaskRawFor(companyId, uptickTaskId);
  if (!raw) return null;
  const b = taskBits(raw.rawPayload as Record<string, unknown>);
  const remarks = await openUptickRemarksFor(companyId, { uptickTaskId, propertyId: b.propertyId });
  const defLines = remarks
    .map((r) => {
      const l = remarkLine(r.rawPayload as Record<string, unknown>);
      return `- ${[l.severity ? `[severity ${l.severity}]` : null, l.headline, l.location ? `(${l.location})` : null, l.fix ? `— recommended: ${l.fix}` : null]
        .filter(Boolean)
        .join(" ")}`;
    })
    .join("\n");
  return `THIS ESTIMATE IS FOR AN UPTICK JOB — treat the following as the job description the technician would otherwise dictate. Use it to propose scope; the technician confirms or refines. Never re-ask details stated here.
Job ${raw.ref ?? raw.uptickTaskId}: ${b.title}${b.description && b.description !== b.title ? `\n${b.description}` : ""}
Customer: ${b.clientName ?? "unknown"} · Site: ${b.propertyName ?? ""}
${remarks.length > 0 ? `OPEN DEFECTS (${remarks.length}) — the likely scope of this estimate:\n${defLines}${REMARK_HINT}` : "No open defects recorded for this job."}`;
}
