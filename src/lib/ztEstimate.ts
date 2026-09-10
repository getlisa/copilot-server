import { ZtConnection } from "@prisma/client";
import prisma from "./prisma";
import logger from "./logger";
import { ztFetch, ZtApiError } from "./zt";
import { ztJobRawFor } from "./ztIngest";
import type { QuoteDto } from "../copilot/estimating/quoteDto";

/**
 * Estimate write-back to ZenTrades (plan 3.x), mirroring the QBO post's rules:
 *  - create on first completion, UPDATE IN PLACE on re-completion (ZenTrades confirmed
 *    PUT /api/billing/estimate works on a sent estimate; billingMetaDataId is required then);
 *  - a not-found on update falls through to create; any other error propagates;
 *  - quotes.ztEstimateId is the idempotency ledger — set only after ZenTrades returns it.
 *
 * VERIFY-ON-TEST-ACCOUNT (marked below): the salesTax object's exact shape, the attachment
 * field, labor/material typeIds, and the update-payload contract come from ZenTrades'
 * engineering review, not from a live call by this code.
 */

interface ZtPostQuote {
  id: string;
  companyId: number;
  ztTicketId: string | null;
  ztEstimateId: string | null;
  ztBillingMetaDataId: string | null;
  salesTaxId: number | null;
  taxExempt: boolean;
  chosenOptionGroup: string | null;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function syncQuoteToZt(
  conn: ZtConnection,
  quote: ZtPostQuote,
  dto: QuoteDto,
  pdf: { fileName: string; base64: string } | null
): Promise<{ ztEstimateId: string; ztBillingMetaDataId: string | null }> {
  if (!quote.ztTicketId) throw new Error("Quote has no ZenTrades job to post against");
  const stored = await ztJobRawFor(quote.companyId, quote.ztTicketId);
  if (!stored) throw new Error("The quote's ZenTrades job is no longer synced");

  // Fresh single-ticket fetch at post time, so the customer/address ids we send are current —
  // the raw row is a snapshot from when the JOB last changed, and customer billing can move
  // without bumping the ticket's updatedAt. Falls back to the snapshot if the fetch fails.
  let ticket = stored.rawPayload as Record<string, unknown>;
  try {
    const fresh = (await ztFetch(conn, `/api/ticket?id=${quote.ztTicketId}`)) as Record<
      string,
      unknown
    > | null;
    // Their single-ticket read may wrap the ticket; adopt the fresh object only when it
    // actually looks like a ticket — replacing the good snapshot with a wrapper would strip
    // the customer/address ids the payload below depends on.
    const candidate =
      fresh && typeof fresh === "object"
        ? ((fresh.ticket as Record<string, unknown> | undefined) ?? fresh)
        : null;
    if (candidate && (candidate.id != null || candidate.customer != null)) ticket = candidate;
  } catch (err) {
    logger.warn("ZT fresh-ticket fetch failed; posting from the synced snapshot", {
      quoteId: quote.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const customer = ticket.customer as Record<string, unknown> | undefined;
  const billing = customer?.billingAddress as Record<string, unknown> | undefined;
  const serviceAddress = ticket.serviceAddress as Record<string, unknown> | undefined;
  // Billing/location split: payer ids from the ticket's `customer`; ONLY serviceAddressId from
  // the location — its own customerId is a different record and must never bill.
  const customerId = num(customer?.id);
  const billingAddressId = num(billing?.id) ?? num(serviceAddress?.id);
  const serviceAddressId = num(serviceAddress?.id);
  if (customerId == null || billingAddressId == null || serviceAddressId == null)
    throw new Error("The ZenTrades job is missing customer or address ids");

  // Tax: live estimates carry the service address's TAX ZONE OBJECT verbatim as `salesTax`
  // (verified by reading estimate 417497), not the {rate, taxRateId} shape their review
  // sketched. Resolution is SNAPSHOT-FIRST like QBO: the quote's sales_tax_zt-linked zone
  // (what the signed document was priced under) wins; the fresh ticket's zone is the
  // fallback for quotes without a link. {} when untaxed (verified accepted). Tax-exempt
  // quotes post every item isTaxExempt — the books can never charge tax the signed document
  // does not show.
  const freshZone = serviceAddress?.taxZone as Record<string, unknown> | undefined;
  let taxZone: Record<string, unknown> | undefined = undefined;
  if (!quote.taxExempt) {
    if (quote.salesTaxId != null) {
      const link = await prisma.salesTaxZt.findFirst({
        where: { salesTaxId: quote.salesTaxId, companyId: quote.companyId },
        select: { raw: true },
      });
      if (link?.raw && typeof link.raw === "object") taxZone = link.raw as Record<string, unknown>;
    }
    taxZone = taxZone ?? freshZone;
  }
  const taxed = !quote.taxExempt && taxZone != null;

  // Only base-scope lines plus the customer's chosen option post as priced lines — ZenTrades'
  // total would otherwise sum alternatives the customer picked between (same rule as QBO).
  const postable = dto.lineItems.filter(
    (i) => i.optionGroup == null || i.optionGroup === quote.chosenOptionGroup
  );
  // v2 item shape, captured verbatim from their web app's own create request: itemType is a
  // string ("Custom"), and the OPEN status trio is sent EXPLICITLY — the v1 endpoint derived
  // status from isApproved and ignored lineItemStatusId, which is why items used to land as
  // NOT_APPROVED. recommendationId (deficiency linkage) stays deferred pending agent-side
  // line→deficiency attribution.
  const items = postable.map((i) => {
    const text = i.unitPrice == null ? `${i.description} — price pending` : i.description;
    return {
      name: text.slice(0, 200),
      quantity: i.quantity ?? 1,
      rate: i.unitPrice ?? 0,
      amount: i.totalPrice ?? 0,
      itemType: "Custom",
      isApproved: true,
      lineItemStatusId: 3,
      lineItemStatusName: "OPEN",
      isTaxExempt: !taxed || i.taxable === false,
    };
  });

  // v2 payload, mirroring the captured web-app request: totals are CLIENT-SENT (v1 stored
  // zeros — it never computed them), tax is the percent, note is an object.
  const invoice: Record<string, unknown> = {
    customerId,
    billingAddressId,
    serviceAddressId,
    salesTax: taxed ? taxZone : {},
    tax: taxed ? (dto.taxRatePercent ?? 0) : 0,
    items,
    note: { text: "" },
    lineItemTotal: dto.total,
    totalBeforeTax: dto.total,
    totalTax: dto.taxAmount,
    invoiceTotal: dto.totalWithTax,
    balance: dto.totalWithTax,
    // VERIFY: the entry shape inside mediaArray (their captured create sent it empty).
    mediaArray: pdf ? [{ fileName: pdf.fileName, data: pdf.base64 }] : [],
  };
  const options = {
    ticket: {
      id: Number(quote.ztTicketId),
      ticketNumber: String(ticket.ticketNumber ?? stored.ticketNumber ?? ""),
    },
    independent: false,
  };

  // Update in place when this quote already posted. THE RULE THAT PREVENTS DUPLICATES:
  // while we hold an estimate id, creating is forbidden unless the estimate is CONFIRMED gone
  // via the live-verified v1 read. An update failure (unknown v2 edit contract, transient
  // error, missing route — all of which arrive as 4xx/404 too) surfaces as an error and a
  // Retry, never as a fresh create: creating on failure is exactly how re-completions minted
  // duplicate estimates once.
  if (quote.ztEstimateId) {
    let current: Record<string, unknown> | null = null;
    let estimateGone = false;
    try {
      current = (await ztFetch(
        conn,
        `/api/billing/estimate?id=${quote.ztEstimateId}`
      )) as Record<string, unknown> | null;
      if (!current || current.id == null || current.isDeleted === true) estimateGone = true;
    } catch (err) {
      if (err instanceof ZtApiError && err.status === 404) estimateGone = true;
      else throw err;
    }
    if (!estimateGone) {
      const invoiceStatusId = num(current?.invoiceStatusId) ?? 1;
      const billingMetaDataId =
        (typeof current?.billingMetaDataId === "string" && current.billingMetaDataId) ||
        quote.ztBillingMetaDataId ||
        undefined;
      const currentItems = Array.isArray(current?.items)
        ? (current.items as Record<string, unknown>[])
        : [];
      const existingIds = currentItems
        .map((it) => num(it.id))
        .filter((n): n is number => n != null);
      // Lines pair onto existing item ids by position (in-place update); extras are deleted;
      // only genuinely new lines go id-less. Both behaviors verified live on 417559.
      const putItems: Record<string, unknown>[] = items.map((it, idx) =>
        existingIds[idx] != null ? { ...it, id: existingIds[idx] } : it
      );
      const itemsToDelete = existingIds.slice(items.length);
      const idFields = {
        id: Number(quote.ztEstimateId),
        invoiceStatusId,
        billingMetaDataId,
      };
      try {
        // Preferred: the v2 edit (matches the captured create contract; PUT-v2 itself is
        // still unobserved — hence the fallback below rather than a fall-through to create).
        const updated = (await ztFetch(conn, "/api/billing/estimate/v2", {
          method: "PUT",
          body: { invoice: { ...invoice, items: putItems, itemsToDelete, ...idFields }, options },
        })) as Record<string, unknown> | null;
        return {
          ztEstimateId: String(updated?.id ?? quote.ztEstimateId),
          ztBillingMetaDataId:
            (typeof billingMetaDataId === "string" ? billingMetaDataId : null) ??
            quote.ztBillingMetaDataId,
        };
      } catch (v2err) {
        logger.warn("ZT v2 edit failed; retrying via the verified v1 edit", {
          quoteId: quote.id,
          error: v2err instanceof Error ? v2err.message : String(v2err),
        });
        // v1-safe shape (everything here verified live): typeId int instead of itemType,
        // no status trio / note / balance / totalBeforeTax, deletions as {id, isDeleted}.
        const v1Items: Record<string, unknown>[] = postable.map((i, idx) => {
          const text = i.unitPrice == null ? `${i.description} — price pending` : i.description;
          return {
            ...(existingIds[idx] != null ? { id: existingIds[idx] } : {}),
            name: text.slice(0, 200),
            quantity: i.quantity ?? 1,
            rate: i.unitPrice ?? 0,
            amount: i.totalPrice ?? 0,
            typeId: 1,
            isTaxExempt: !taxed || i.taxable === false,
          };
        });
        for (const extraId of existingIds.slice(postable.length)) {
          v1Items.push({ id: extraId, isDeleted: true });
        }
        const updated = (await ztFetch(conn, "/api/billing/estimate", {
          method: "PUT",
          body: {
            invoice: {
              customerId,
              billingAddressId,
              serviceAddressId,
              salesTax: taxed ? taxZone : {},
              items: v1Items,
              lineItemTotal: dto.total,
              totalTax: dto.taxAmount,
              invoiceTotal: dto.totalWithTax,
              ...idFields,
            },
            options: {
              ticket: {
                id: Number(quote.ztTicketId),
                ticketNumber: String(ticket.ticketNumber ?? stored.ticketNumber ?? ""),
              },
            },
          },
        })) as Record<string, unknown> | null;
        return {
          ztEstimateId: String(updated?.id ?? quote.ztEstimateId),
          ztBillingMetaDataId:
            (typeof billingMetaDataId === "string" ? billingMetaDataId : null) ??
            quote.ztBillingMetaDataId,
        };
      }
    }
    logger.warn("ZT estimate confirmed gone; creating a fresh one", { quoteId: quote.id });
  }

  // Orphan adoption via the ticket's LIVE estimate list (GET /api/billing/estimate/ticketId —
  // verified working curl): if a previous attempt created our estimate but died before we
  // persisted its id, adopt it instead of creating a duplicate. Best-effort like QBO's probe —
  // a failed listing degrades to create, the behavior that existed before.
  try {
    const listing = await ztFetch(conn, `/api/billing/estimate/ticketId?id=${quote.ztTicketId}`);
    const estimates: Record<string, unknown>[] = Array.isArray(listing)
      ? (listing as Record<string, unknown>[])
      : (((listing as Record<string, unknown> | null)?.list ??
          (listing as Record<string, unknown> | null)?.hits ??
          []) as Record<string, unknown>[]);
    // Ours are recognized by estimateSyncData — their purpose-built external-mapping field
    // (a string `note` is refused by their validation, so QBO's PrivateNote trick can't work
    // here). Matched defensively by substring: the field's exact shape is still VERIFY.
    const orphan = estimates.find(
      (e) => e.estimateSyncData != null && JSON.stringify(e.estimateSyncData).includes(quote.id)
    );
    if (orphan?.id != null) {
      logger.info("ZT orphan estimate adopted instead of creating a duplicate", {
        quoteId: quote.id,
        ztEstimateId: String(orphan.id),
      });
      const meta =
        orphan.billingMetaDataId ??
        (orphan.billingMetaData as Record<string, unknown> | undefined)?.id ??
        null;
      // Ids only — the content push rides the next re-completion/retry via the update path,
      // now that the id is persisted. Same best-effort contract as QBO's adoption.
      return {
        ztEstimateId: String(orphan.id),
        ztBillingMetaDataId: meta != null ? String(meta) : null,
      };
    }
  } catch (err) {
    logger.warn("ZT estimate-listing probe failed; proceeding to create", {
      quoteId: quote.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const created = (await ztFetch(conn, "/api/billing/estimate/v2", {
    method: "POST",
    body: { invoice: { ...invoice, itemsToDelete: [] }, options },
  })) as Record<string, unknown> | null;
  const ztEstimateId = created?.id != null ? String(created.id) : null;
  if (!ztEstimateId) throw new Error("ZenTrades did not return an estimate id");
  const meta =
    created?.billingMetaDataId ??
    (created?.billingMetaData as Record<string, unknown> | undefined)?.id ??
    null;

  // Register the CLARA↔ZenTrades mapping in their estimatesync ledger — what the adoption
  // probe above matches on. Best-effort: the id is already persisted on our side, so a failed
  // registration only weakens the duplicate guard, never the post. VERIFY the exact field
  // names against their estimate-sync schema on the next live pass.
  try {
    await ztFetch(conn, "/api/billing/estimate/estimatesync", {
      method: "POST",
      body: {
        estimateId: Number(ztEstimateId),
        externalPartyName: "CLARA",
        externalFieldName: "claraQuoteId",
        externalFieldValue: quote.id,
      },
    });
  } catch (err) {
    logger.warn("ZT estimatesync registration failed (duplicate guard weakened)", {
      quoteId: quote.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { ztEstimateId, ztBillingMetaDataId: meta != null ? String(meta) : null };
}
