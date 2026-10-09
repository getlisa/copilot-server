import { HcpConnection } from "@prisma/client";
import logger from "./logger";
import { hcpFetch, uploadHcpAttachment, HcpApiError } from "./hcp";
import { hcpServiceItemResolver, jobBits, type HcpItemKind } from "./hcpIngest";
import type { QuoteDto } from "../copilot/estimating/quoteDto";

/**
 * Estimate write-back to Housecall Pro — the uptickEstimate.ts rules, HCP's model:
 *  - a completed CLARA estimate becomes an HCP ESTIMATE (Estimates tab) for the originating
 *    job's customer + service address, with ONE option carrying the lines (base scope + the
 *    customer's chosen option group, the QBO/ZenTrades rule). HCP's `POST /estimates` has no
 *    job_id and no note is written; the pro sends/approves it from Housecall Pro as usual;
 *  - re-completing after a reopen rewrites the same option's lines in place via
 *    `PUT /estimates/{id}/options/{id}/line_items/bulk_update`, which edits a line when its `id`
 *    is sent and appends otherwise. So a re-sync reuses the option's existing line ids by
 *    position and zeroes any surplus (there is no delete-line endpoint for estimate options);
 *  - line items: name, unit_price in integer CENTS, quantity, kind labor | materials (CLARA's
 *    isLabor), taxable (the line's flag; a tax-exempt quote posts every line untaxable),
 *    service_item_id/type when the line was priced from the synced catalog;
 *  - tax: the option's `tax` is the quote's rate as a 0–1 decimal when it has one, `taxable:false`
 *    when exempt, otherwise omitted so HCP's own default applies;
 *  - the proposal PDF is attached to the option, best-effort;
 *  - the estimate id/option id/estimate_number are returned for the quote row (quotes.hcp_*) — a
 *    deleted HCP estimate (404) is re-created on the next sync.
 */

interface HcpPostQuote {
  id: string;
  companyId: number;
  hcpJobId: string | null;
  hcpEstimateId: string | null;
  hcpOptionId: string | null;
  chosenOptionGroup: string | null;
  taxExempt?: boolean | null;
  taxRatePercent?: unknown;
}

export interface HcpLineItemPayload {
  id?: string;
  name: string;
  unit_price: number;
  quantity: number;
  kind: "labor" | "materials";
  taxable: boolean;
  service_item_id?: string;
  service_item_type?: HcpItemKind;
}

export interface HcpSyncResult {
  estimateId: string;
  optionId: string;
  estimateRef: string | null;
  lineItems: number;
}

/** Pure: the bulk_update line items. Exported for the check script. */
export function hcpLineItemsPayload(
  quote: Pick<HcpPostQuote, "chosenOptionGroup" | "taxExempt">,
  dto: Pick<QuoteDto, "lineItems">,
  serviceItemFor: (line: { description: string; pricebookCode: string | null }) => { id: string; type: HcpItemKind } | null = () => null
): HcpLineItemPayload[] {
  // Only base-scope lines plus the customer's chosen option post (same rule as QBO/ZenTrades).
  const postable = dto.lineItems.filter((i) => i.optionGroup == null || i.optionGroup === quote.chosenOptionGroup);
  return postable.map((i) => {
    const item = serviceItemFor(i);
    return {
      name: (i.unitPrice == null ? `${i.description} — price pending` : i.description).slice(0, 255),
      unit_price: Math.round((i.unitPrice ?? 0) * 100),
      quantity: Math.round((i.quantity ?? 1) * 100) / 100,
      kind: i.isLabor ? "labor" : "materials",
      taxable: quote.taxExempt ? false : i.taxable !== false,
      ...(item ? { service_item_id: item.id, service_item_type: item.type } : {}),
    };
  });
}

/**
 * Pure: a re-sync's bulk_update body. Existing option line ids are reused by position so HCP
 * edits those lines instead of appending; surplus old lines are zeroed and renamed since
 * estimate options have no delete-line endpoint. Exported for the check script.
 */
export function mergeHcpLineIds(lines: HcpLineItemPayload[], existingIds: string[]): HcpLineItemPayload[] {
  const merged = lines.map((l, i) => (existingIds[i] ? { ...l, id: existingIds[i] } : l));
  for (const id of existingIds.slice(lines.length))
    merged.push({ id, name: "(removed)", unit_price: 0, quantity: 0, kind: "materials", taxable: false });
  return merged;
}

/** Pure: the option's `tax` object, or undefined to let HCP's default apply. */
export function hcpOptionTax(quote: Pick<HcpPostQuote, "taxExempt" | "taxRatePercent">) {
  if (quote.taxExempt) return { taxable: false };
  const pct = quote.taxRatePercent == null ? NaN : Number(quote.taxRatePercent);
  if (!Number.isFinite(pct)) return undefined;
  return { taxable: true, tax_rate: Math.round(pct * 1e4) / 1e6, tax_name: "Sales Tax" };
}

/** The quote-row update for a successful post. */
export const hcpSyncedData = (r: HcpSyncResult) => ({
  hcpSyncedAt: new Date(),
  hcpSyncError: null,
  hcpEstimateId: r.estimateId,
  hcpOptionId: r.optionId,
  ...(r.estimateRef ? { hcpEstimateRef: r.estimateRef } : {}),
});

const idOf = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

/** Create (or update in place) the HCP estimate for a completed quote. */
export async function syncQuoteToHcp(
  conn: HcpConnection,
  quote: HcpPostQuote,
  dto: QuoteDto,
  pdf: { fileName: string; buffer: Buffer } | null
): Promise<HcpSyncResult> {
  if (!quote.hcpJobId) throw new Error("This quote is not linked to a Housecall Pro job");

  let job: Record<string, unknown> | null;
  try {
    job = await hcpFetch<Record<string, unknown>>(conn, `jobs/${encodeURIComponent(quote.hcpJobId)}`);
  } catch (err) {
    if (err instanceof HcpApiError && err.status === 404)
      throw new Error(`Housecall Pro job ${quote.hcpJobId} no longer exists — it was deleted in Housecall Pro`);
    throw err;
  }
  const bits = jobBits(job ?? {});
  if (!bits.customerId) throw new Error(`Housecall Pro job ${bits.invoiceNumber ?? quote.hcpJobId} has no customer to estimate for`);

  const lines = hcpLineItemsPayload(quote, dto, await hcpServiceItemResolver(quote.companyId));
  if (lines.length === 0) throw new Error("The estimate has no line items to send");

  // Existing estimate: confirm it still exists and find its option; a 404 falls through to create.
  let estimateId = quote.hcpEstimateId;
  let optionId = quote.hcpOptionId;
  let estimateRef: string | null = null;
  let existingIds: string[] = [];
  if (estimateId) {
    try {
      const est = await hcpFetch<Record<string, unknown>>(conn, `estimates/${encodeURIComponent(estimateId)}`);
      const options = Array.isArray(est?.options) ? (est!.options as Record<string, unknown>[]) : [];
      optionId = idOf(options.find((o) => idOf(o.id) === optionId)?.id ?? options[0]?.id);
      estimateRef = idOf(est?.estimate_number);
      if (!optionId) {
        const opt = await hcpFetch<Record<string, unknown>>(conn, `estimates/${encodeURIComponent(estimateId)}/options`, {
          method: "POST",
          body: { name: quote.chosenOptionGroup ?? "Estimate", tax: hcpOptionTax(quote) },
        });
        optionId = idOf(opt?.id);
      } else {
        // ponytail: one page of 100 — an estimate option with more lines than that is not real.
        const page = await hcpFetch<Record<string, unknown>>(
          conn,
          `estimates/${encodeURIComponent(estimateId)}/options/${encodeURIComponent(optionId)}/line_items?page_size=100`
        );
        const rows = Array.isArray(page?.line_items) ? page!.line_items : Array.isArray(page?.data) ? page!.data : [];
        existingIds = (rows as Record<string, unknown>[]).map((r) => idOf(r.id)).filter((x): x is string => !!x);
      }
    } catch (err) {
      if (!(err instanceof HcpApiError && err.status === 404)) throw err;
      estimateId = null;
      optionId = null;
    }
  }

  if (!estimateId || !optionId) {
    const addressId = idOf(bits.address?.id);
    const created = await hcpFetch<Record<string, unknown>>(conn, "estimates", {
      method: "POST",
      body: {
        customer_id: bits.customerId,
        ...(addressId ? { address_id: addressId } : {}),
        options: [{ name: quote.chosenOptionGroup ?? "Estimate", tax: hcpOptionTax(quote) }],
      },
    });
    estimateId = idOf(created?.id);
    const firstOption = Array.isArray(created?.options) ? (created!.options as Record<string, unknown>[])[0] : undefined;
    optionId = idOf(firstOption?.id);
    estimateRef = idOf(created?.estimate_number);
    if (!estimateId || !optionId) throw new Error("Housecall Pro created the estimate without an id or option — nothing to write lines onto");
    existingIds = [];
  }

  const optionPath = `estimates/${encodeURIComponent(estimateId)}/options/${encodeURIComponent(optionId)}`;
  await hcpFetch(conn, `${optionPath}/line_items/bulk_update`, {
    method: "PUT",
    body: { line_items: mergeHcpLineIds(lines, existingIds) },
  });

  if (pdf) {
    try {
      await uploadHcpAttachment(conn, optionPath, { fileName: pdf.fileName, buffer: pdf.buffer, contentType: "application/pdf" });
    } catch (err) {
      logger.warn("Housecall Pro proposal PDF attach failed (line items posted without it)", {
        quoteId: quote.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { estimateId, optionId, estimateRef, lineItems: lines.length };
}
