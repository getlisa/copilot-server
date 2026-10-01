import { UptickConnection } from "@prisma/client";
import logger from "./logger";
import { uptickFetch, uploadUptickDocument, jaDoc, jaRows, jaRelId, UptickApiError, type JaResource } from "./uptick";
import { uptickTaskRawFor, openUptickRemarksFor, uptickProductResolver } from "./uptickIngest";
import type { QuoteDto } from "../copilot/estimating/quoteDto";

/**
 * Estimate write-back to Uptick — ztEstimate.ts rules, Uptick's model:
 *  - a CLARA estimate becomes a DEFECT QUOTE on the task's property/client (Uptick's quote for
 *    remedial work; the task's remarks are what it fixes), left in DRAFT for the technician to
 *    finalise. Every line carries an Uptick PRODUCT (required by their UI — a line without one
 *    reads "no product found"): the synced catalog item it was priced from, else a name match,
 *    else the company's generic product (uptickProductResolver);
 *  - create on first completion, UPDATE IN PLACE on re-completion (PATCH the quote, replace its
 *    line items); a not-found on update falls through to create; any other error propagates;
 *  - quotes.uptickQuoteId is the idempotency ledger, set only after Uptick returns it;
 *  - the proposal PDF is attached to the TASK (the job) and to the quote, best-effort.
 * ponytail: no orphan adoption — Uptick has no external-id field to match on; a create that
 * dies before we persist its id leaves one stray Draft quote for the technician to void.
 *
 * VERIFY-ON-TENANT: attribute/relationship names (description, scope_of_works, date,
 * unit_price, quantity, index, quote, remark) come from the v2.15 connector field lists.
 */

interface UptickPostQuote {
  id: string;
  companyId: number;
  uptickTaskId: string | null;
  uptickQuoteId: string | null;
  chosenOptionGroup: string | null;
  customerName: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Pure: the defect-quote attributes + line payloads for a quote. Exported for the check script. */
export function uptickQuotePayload(
  quote: Pick<UptickPostQuote, "id" | "chosenOptionGroup" | "customerName">,
  dto: Pick<QuoteDto, "lineItems" | "total">,
  taskRef: string | null,
  remarks: { id: string; text: string }[],
  productIdFor: (line: { description: string; pricebookCode: string | null; isLabor?: boolean }) => string | null = () => null
): {
  attributes: Record<string, unknown>;
  lines: { attributes: Record<string, unknown>; remarkId: string | null; productId: string | null }[];
} {
  // Only base-scope lines plus the customer's chosen option post — Uptick's total would
  // otherwise sum alternatives the customer picked between (same rule as QBO/ZenTrades).
  const postable = dto.lineItems.filter((i) => i.optionGroup == null || i.optionGroup === quote.chosenOptionGroup);
  const byText = new Map(remarks.map((r) => [norm(r.text), r.id]));
  const lines = postable.map((i, idx) => {
    const text = i.unitPrice == null ? `${i.description} — price pending` : i.description;
    // A seeded remark line keeps the remark's own wording, so an exact normalized match links it.
    const remarkId = byText.get(norm(i.description)) ?? null;
    return {
      attributes: {
        description: text.slice(0, 500),
        quantity: i.quantity ?? 1,
        unit_price: i.unitPrice ?? 0,
        index: idx,
      },
      remarkId,
      productId: productIdFor(i),
    };
  });
  const scope = postable.map((i) => `• ${i.description}${i.quantity && i.quantity !== 1 ? ` ×${i.quantity}` : ""}`).join("\n");
  return {
    attributes: {
      description: `${quote.customerName ? `Estimate for ${quote.customerName}` : "CLARA estimate"}${taskRef ? ` — job ${taskRef}` : ""}`.slice(0, 200),
      scope_of_works: `${scope}\n\nTotal (ex tax): ${dto.total.toFixed(2)}\nPrepared in CLARA (${quote.id.slice(0, 8)}).`,
      date: new Date().toISOString().slice(0, 10),
    },
    lines,
  };
}

const attr = (r: JaResource | null | undefined, name: string): unknown => r?.attributes?.[name];

export async function syncQuoteToUptick(
  conn: UptickConnection,
  quote: UptickPostQuote,
  dto: QuoteDto,
  pdf: { fileName: string; buffer: Buffer } | null
): Promise<{ uptickQuoteId: string; uptickQuoteRef: string | null }> {
  if (!quote.uptickTaskId) throw new Error("Quote has no Uptick job to post against");
  const stored = await uptickTaskRawFor(quote.companyId, quote.uptickTaskId);
  if (!stored) throw new Error("The quote's Uptick job is no longer synced");
  const raw = stored.rawPayload as Record<string, unknown>;
  const rels = (raw.relationships ?? {}) as Record<string, { data?: { id?: unknown } | null }>;
  const relId = (name: string) => (rels[name]?.data?.id != null ? String(rels[name]!.data!.id) : null);
  const property = raw.property as Record<string, unknown> | null;
  const propRels = (property?.relationships ?? {}) as Record<string, { data?: { id?: unknown } | null }>;
  const propertyId = relId("property");
  const clientId = relId("client") ?? (propRels.client?.data?.id != null ? String(propRels.client.data.id) : null);
  if (!propertyId) throw new Error("The Uptick task has no property to quote against");

  const remarks = (await openUptickRemarksFor(quote.companyId, { uptickTaskId: quote.uptickTaskId, propertyId })).map((r) => {
    const p = r.rawPayload as Record<string, unknown>;
    return { id: r.uptickRemarkId, text: String(p.resolution ?? p.description ?? p.notes ?? "") };
  });
  const payload = uptickQuotePayload(quote, dto, stored.ref, remarks, await uptickProductResolver(quote.companyId));

  const createLines = async (quoteId: string) => {
    for (const l of payload.lines) {
      await uptickFetch(conn, "defectquotelineitems/", {
        method: "POST",
        body: jaDoc("DefectQuoteLineItem", l.attributes, {
          quote: { type: "DefectQuote", id: quoteId },
          remark: { type: "Remark", id: l.remarkId },
          product: { type: "Product", id: l.productId },
        }),
      });
    }
  };

  let uptickQuoteId: string | null = null;
  let uptickQuoteRef: string | null = null;

  // Update in place while we hold an id — creating is forbidden unless the quote is CONFIRMED
  // gone (404). An update failure surfaces as an error + Retry, never as a fresh create.
  if (quote.uptickQuoteId) {
    let current: JaResource | null = null;
    try {
      current = jaRows(await uptickFetch(conn, `defectquotes/${quote.uptickQuoteId}/`))[0] ?? null;
    } catch (err) {
      if (!(err instanceof UptickApiError && err.status === 404)) throw err;
    }
    if (current) {
      const status = String(attr(current, "status") ?? "");
      if (status && !/draft/i.test(status))
        throw new Error(`Uptick quote ${attr(current, "ref") ?? quote.uptickQuoteId} is ${status} — revert it to Draft in Uptick to re-sync`);
      await uptickFetch(conn, `defectquotes/${quote.uptickQuoteId}/`, {
        method: "PATCH",
        body: jaDoc("DefectQuote", payload.attributes, {}, quote.uptickQuoteId),
      });
      // VERIFY: bare field filter `?quote=<id>` (their updatedsince filter is bare too).
      const existing = jaRows(await uptickFetch(conn, `defectquotelineitems/?quote=${quote.uptickQuoteId}&page[limit]=200`));
      for (const li of existing) {
        if (jaRelId(li, "quote") && jaRelId(li, "quote") !== quote.uptickQuoteId) continue;
        await uptickFetch(conn, `defectquotelineitems/${li.id}/`, { method: "DELETE" });
      }
      await createLines(quote.uptickQuoteId);
      uptickQuoteId = quote.uptickQuoteId;
      uptickQuoteRef = (attr(current, "ref") as string | undefined) ?? null;
    } else {
      logger.warn("Uptick quote confirmed gone; creating a fresh one", { quoteId: quote.id });
    }
  }

  if (!uptickQuoteId) {
    const created = jaRows(
      await uptickFetch(conn, "defectquotes/", {
        method: "POST",
        body: jaDoc("DefectQuote", payload.attributes, {
          property: { type: "Property", id: propertyId },
          client: { type: "Client", id: clientId },
        }),
      })
    )[0];
    if (!created?.id) throw new Error("Uptick did not return a quote id");
    uptickQuoteId = String(created.id);
    uptickQuoteRef = (attr(created, "ref") as string | undefined) ?? null;
    await createLines(uptickQuoteId);
  }

  if (pdf) {
    const file = { fileName: pdf.fileName, buffer: pdf.buffer, contentType: "application/pdf" };
    for (const [resource, id] of [
      ["tasks", quote.uptickTaskId],
      ["defectquotes", uptickQuoteId],
    ] as const) {
      try {
        await uploadUptickDocument(conn, resource, id, file);
      } catch (err) {
        logger.warn("Uptick proposal PDF attach failed (quote posted without it)", {
          quoteId: quote.id,
          resource,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { uptickQuoteId, uptickQuoteRef };
}
