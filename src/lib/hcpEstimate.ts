import { HcpConnection } from "@prisma/client";
import logger from "./logger";
import { hcpFetch, uploadHcpJobAttachment, HcpApiError } from "./hcp";
import { hcpServiceItemResolver, type HcpItemKind } from "./hcpIngest";
import type { QuoteDto } from "../copilot/estimating/quoteDto";

/**
 * Estimate write-back to Housecall Pro — the uptickEstimate.ts rules, HCP's model:
 *  - there is no separate quote object to create: a CLARA estimate becomes the JOB'S OWN LINE
 *    ITEMS (PUT /jobs/{id}/line_items/bulk_update with append_line_items=false, which replaces
 *    the job's whole list). The pro then sends/invoices the job from Housecall Pro as usual;
 *  - that makes every post an update in place — re-completing after a reopen rewrites the same
 *    list, and the job itself is the idempotency ledger (quotes.hcp_synced_at records it);
 *  - line items: name, unit_price in integer CENTS, quantity, kind labor | materials (CLARA's
 *    isLabor), taxable (the line's flag; a tax-exempt quote posts every line untaxable — HCP
 *    applies the job's own rate to taxable lines), service_item_id/type when the line was priced
 *    from the synced catalog;
 *  - a canceled job is refused — their workflow owns it from there;
 *  - the proposal PDF is attached to the job (POST /jobs/{id}/attachments), best-effort.
 * ponytail: lines a pro typed directly on the job in HCP are replaced too — the estimate owns
 * the job's lines. Switch to append_line_items=true + per-id updates if a client needs both.
 */

interface HcpPostQuote {
  id: string;
  companyId: number;
  hcpJobId: string | null;
  chosenOptionGroup: string | null;
  taxExempt?: boolean | null;
}

export interface HcpLineItemPayload {
  name: string;
  unit_price: number;
  quantity: number;
  kind: "labor" | "materials";
  taxable: boolean;
  service_item_id?: string;
  service_item_type?: HcpItemKind;
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

/** Write the completed estimate onto its HCP job. Returns the number of lines posted. */
export async function syncQuoteToHcp(
  conn: HcpConnection,
  quote: HcpPostQuote,
  dto: QuoteDto,
  pdf: { fileName: string; buffer: Buffer } | null
): Promise<{ lineItems: number }> {
  if (!quote.hcpJobId) throw new Error("This quote is not linked to a Housecall Pro job");
  const jobPath = `jobs/${encodeURIComponent(quote.hcpJobId)}`;

  let job: Record<string, unknown> | null;
  try {
    job = await hcpFetch<Record<string, unknown>>(conn, jobPath);
  } catch (err) {
    if (err instanceof HcpApiError && err.status === 404)
      throw new Error(`Housecall Pro job ${quote.hcpJobId} no longer exists — it was deleted in Housecall Pro`);
    throw err;
  }
  const status = String(job?.work_status ?? "");
  if (/canceled/i.test(status))
    throw new Error(`Housecall Pro job ${String(job?.invoice_number ?? quote.hcpJobId)} is ${status} — restore it in Housecall Pro to sync`);

  const line_items = hcpLineItemsPayload(quote, dto, await hcpServiceItemResolver(quote.companyId));
  if (line_items.length === 0) throw new Error("The estimate has no line items to send");
  await hcpFetch(conn, `${jobPath}/line_items/bulk_update`, {
    method: "PUT",
    body: { line_items, append_line_items: false },
  });

  if (pdf) {
    try {
      await uploadHcpJobAttachment(conn, quote.hcpJobId, { fileName: pdf.fileName, buffer: pdf.buffer, contentType: "application/pdf" });
    } catch (err) {
      logger.warn("Housecall Pro proposal PDF attach failed (line items posted without it)", {
        quoteId: quote.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { lineItems: line_items.length };
}
