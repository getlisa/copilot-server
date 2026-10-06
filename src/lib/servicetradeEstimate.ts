import { ServicetradeConnection } from "@prisma/client";
import logger from "./logger";
import { servicetradeFetch, uploadServicetradeAttachment, ServicetradeApiError, ST_ENTITY } from "./servicetrade";
import { servicetradeJobRawFor, openServicetradeDeficienciesFor, servicetradeLibItemResolver, jobBits, deficiencyLine } from "./servicetradeIngest";
import type { QuoteDto } from "../copilot/estimating/quoteDto";

/**
 * Estimate write-back to ServiceTrade — uptickEstimate.ts rules, ServiceTrade's model:
 *  - a CLARA estimate becomes a QUOTE (status draft) at the job's location for the job's
 *    customer, posted by the connected company as vendor. ServiceTrade's quote needs at least
 *    one SERVICE REQUEST (the scope line the quote fulfils): one per open deficiency a line
 *    covers (deficiencyId links it, so the deficiency reads "out for quote" on their side),
 *    else one general service request with the whole scope;
 *  - line items via POST /quote/{id}/item: description, quantity, price, taxRate (the quote's
 *    snapshot rate on taxable lines, 0 otherwise), libItemId when the line was priced from the
 *    synced catalog, serviceLineId always (required when a line has no lib item);
 *  - create on first completion, UPDATE IN PLACE on re-completion (PUT the quote, replace its
 *    items; service requests kept); a not-found on update falls through to create; a quote no
 *    longer in draft/new is refused — their workflow owns it from submission on;
 *  - quotes.stQuoteId is the idempotency ledger, set only after ServiceTrade returns it;
 *  - the proposal PDF is attached to the quote and the job (purpose: generic), best-effort.
 * ponytail: no orphan adoption — their externalid resource needs an external system the account
 * has configured, which we cannot assume; a create that dies before we persist its id leaves one
 * stray draft quote for the technician to cancel.
 */

interface StPostQuote {
  id: string;
  companyId: number;
  stJobId: string | null;
  stQuoteId: string | null;
  chosenOptionGroup: string | null;
  customerName: string | null;
  taxExempt?: boolean | null;
}

/** ServiceTrade's accepted quote jobType values; anything else posts as "repair". */
const QUOTE_JOB_TYPES = new Set([
  "unknown", "repair", "construction", "upgrade", "service_call", "urgent_service_call", "priority_service_call",
  "emergency_service_call", "cleaning", "inspection", "priority_inspection", "survey", "preventative_maintenance",
  "quality_assurance", "delivery", "pickup", "exchange", "sales", "installation", "warranty",
]);
export const quoteJobType = (jobType: string | null): string => (jobType && QUOTE_JOB_TYPES.has(jobType) ? jobType : "repair");

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Pure: the quote fields + item payloads + which deficiencies the lines cover. Exported for the
 *  check script. */
export function servicetradeQuotePayload(
  quote: Pick<StPostQuote, "id" | "chosenOptionGroup" | "customerName" | "taxExempt">,
  dto: Pick<QuoteDto, "lineItems" | "total" | "taxRatePercent">,
  job: { number: string | null; jobType: string | null },
  deficiencies: { id: string; text: string }[],
  libItemIdFor: (line: { description: string; pricebookCode: string | null }) => string | null = () => null
): {
  quote: { name: string; description: string; notes: string; jobType: string };
  items: { description: string; quantity: number; price: number; taxRate: number | null; libItemId: string | null }[];
  deficiencyIds: string[];
} {
  // Only base-scope lines plus the customer's chosen option post (same rule as QBO/ZenTrades).
  const postable = dto.lineItems.filter((i) => i.optionGroup == null || i.optionGroup === quote.chosenOptionGroup);
  const byText = new Map(deficiencies.map((d) => [norm(d.text), d.id]));
  const rate = quote.taxExempt ? 0 : dto.taxRatePercent;
  const covered = new Set<string>();
  const items = postable.map((i) => {
    const id = byText.get(norm(i.description));
    if (id) covered.add(id);
    return {
      description: (i.unitPrice == null ? `${i.description} — price pending` : i.description).slice(0, 500),
      quantity: i.quantity ?? 1,
      price: i.unitPrice ?? 0,
      // null = no snapshot rate → let ServiceTrade apply the location's own group.
      taxRate: rate == null ? null : i.taxable ? rate : 0,
      libItemId: libItemIdFor(i),
    };
  });
  const scope = postable.map((i) => `• ${i.description}${i.quantity && i.quantity !== 1 ? ` ×${i.quantity}` : ""}`).join("\n");
  const name = `${quote.customerName ? `Estimate for ${quote.customerName}` : "CLARA estimate"}${job.number ? ` — job #${job.number}` : ""}`.slice(0, 100);
  return {
    quote: {
      name,
      description: scope.slice(0, 2000) || name,
      notes: `${scope}\n\nTotal (ex tax): ${dto.total.toFixed(2)}\nPrepared in CLARA (${quote.id.slice(0, 8)}).`,
      jobType: quoteJobType(job.jobType),
    },
    items,
    deficiencyIds: [...covered],
  };
}

export async function syncQuoteToServicetrade(
  conn: ServicetradeConnection,
  quote: StPostQuote,
  dto: QuoteDto,
  pdf: { fileName: string; buffer: Buffer } | null
): Promise<{ stQuoteId: string; stQuoteRef: string | null }> {
  if (!quote.stJobId) throw new Error("Quote has no ServiceTrade job to post against");
  const stored = await servicetradeJobRawFor(quote.companyId, quote.stJobId);
  if (!stored) throw new Error("The quote's ServiceTrade job is no longer synced");
  const b = jobBits(stored.rawPayload as Record<string, unknown>);
  if (!b.locationId) throw new Error("The ServiceTrade job has no location to quote against");
  const vendorId = conn.stCompanyId ?? b.vendorId;
  if (!vendorId) throw new Error("No ServiceTrade vendor id on the connection");

  const open = await openServicetradeDeficienciesFor(quote.companyId, { stJobId: quote.stJobId, locationId: b.locationId });
  const deficiencies = open.map((d) => {
    const l = deficiencyLine(d.rawPayload as Record<string, unknown>);
    return { id: d.stDeficiencyId, text: l.fix ?? l.headline, serviceLineId: (d.rawPayload as { serviceLine?: { id?: unknown } }).serviceLine?.id };
  });
  const payload = servicetradeQuotePayload(quote, dto, b, deficiencies, await servicetradeLibItemResolver(quote.companyId));

  // A service line is required on service requests and on lib-item-less quote items: the job's
  // own, else the first covered deficiency's, else the account's first.
  const coveredLine = deficiencies.find((d) => payload.deficiencyIds.includes(d.id) && d.serviceLineId != null)?.serviceLineId;
  let serviceLineId: string | null = b.serviceLineId ?? (coveredLine != null ? String(coveredLine) : null);
  if (!serviceLineId) {
    const sl = await servicetradeFetch<{ servicelines?: { id?: number }[] }>(conn, "serviceline");
    serviceLineId = sl?.servicelines?.[0]?.id != null ? String(sl.servicelines[0].id) : null;
  }
  if (!serviceLineId) throw new Error("ServiceTrade has no service line to file the quote under");

  const createItems = async (stQuoteId: string) => {
    for (const it of payload.items) {
      await servicetradeFetch(conn, `quote/${stQuoteId}/item`, {
        method: "POST",
        body: {
          quantity: it.quantity,
          price: it.price,
          ...(it.taxRate != null ? { taxRate: it.taxRate } : {}),
          ...(it.libItemId ? { libItemId: Number(it.libItemId), description: it.description } : { description: it.description }),
          serviceLineId: Number(serviceLineId),
        },
      });
    }
  };

  let stQuoteId: string | null = null;
  let stQuoteRef: string | null = null;

  // Update in place while we hold an id — creating is forbidden unless the quote is CONFIRMED
  // gone (404). An update failure surfaces as an error + Retry, never as a fresh create.
  if (quote.stQuoteId) {
    let current: Record<string, unknown> | null = null;
    try {
      current = await servicetradeFetch<Record<string, unknown>>(conn, `quote/${quote.stQuoteId}`);
    } catch (err) {
      if (!(err instanceof ServicetradeApiError && err.status === 404)) throw err;
    }
    if (current) {
      const status = String(current.status ?? "");
      if (status && !/^(draft|new)$/i.test(status))
        throw new Error(`ServiceTrade quote ${current.refNumber ?? quote.stQuoteId} is ${status} — reopen it to Draft in ServiceTrade to re-sync`);
      await servicetradeFetch(conn, `quote/${quote.stQuoteId}`, { method: "PUT", body: payload.quote });
      const existing = await servicetradeFetch<{ items?: { id?: number }[] }>(conn, `quote/${quote.stQuoteId}/item`);
      for (const li of existing?.items ?? []) {
        if (li.id != null) await servicetradeFetch(conn, `quote/${quote.stQuoteId}/item/${li.id}`, { method: "DELETE" });
      }
      await createItems(quote.stQuoteId);
      stQuoteId = quote.stQuoteId;
      stQuoteRef = current.refNumber != null ? String(current.refNumber) : null;
    } else {
      logger.warn("ServiceTrade quote confirmed gone; creating a fresh one", { quoteId: quote.id });
    }
  }

  if (!stQuoteId) {
    // Service requests first: one per covered deficiency, else one for the whole scope.
    const srIds: number[] = [];
    const srBase = { locationId: Number(b.locationId), serviceLineId: Number(serviceLineId) };
    if (payload.deficiencyIds.length > 0) {
      for (const id of payload.deficiencyIds) {
        const d = deficiencies.find((x) => x.id === id)!;
        const sr = await servicetradeFetch<{ id?: number }>(conn, "servicerequest", {
          method: "POST",
          body: { ...srBase, description: d.text.slice(0, 500), deficiencyId: Number(id), ...(d.serviceLineId != null ? { serviceLineId: Number(d.serviceLineId) } : {}) },
        });
        if (sr?.id != null) srIds.push(sr.id);
      }
    }
    if (srIds.length === 0) {
      const sr = await servicetradeFetch<{ id?: number }>(conn, "servicerequest", {
        method: "POST",
        body: { ...srBase, description: payload.quote.description.slice(0, 500) },
      });
      if (sr?.id == null) throw new Error("ServiceTrade did not return a service request id");
      srIds.push(sr.id);
    }
    const created = await servicetradeFetch<{ id?: number; refNumber?: unknown }>(conn, "quote", {
      method: "POST",
      body: {
        ...payload.quote,
        vendorId: Number(vendorId),
        locationId: Number(b.locationId),
        ...(b.customerId ? { customerId: Number(b.customerId) } : {}),
        serviceRequestIds: srIds,
        status: "draft",
      },
    });
    if (created?.id == null) throw new Error("ServiceTrade did not return a quote id");
    stQuoteId = String(created.id);
    stQuoteRef = created.refNumber != null ? String(created.refNumber) : null;
    await createItems(stQuoteId);
  }

  if (pdf) {
    const file = { fileName: pdf.fileName, buffer: pdf.buffer, contentType: "application/pdf", description: "CLARA proposal" };
    for (const entity of [
      { type: ST_ENTITY.QUOTE, id: stQuoteId },
      { type: ST_ENTITY.JOB, id: quote.stJobId },
    ]) {
      try {
        await uploadServicetradeAttachment(conn, entity, file);
      } catch (err) {
        logger.warn("ServiceTrade proposal PDF attach failed (quote posted without it)", {
          quoteId: quote.id,
          entity,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { stQuoteId, stQuoteRef };
}
