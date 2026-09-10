import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { loadCompanyPricing } from "./companyPricing";
import { unitsCompatible } from "./packMath";
import { Prisma } from "@prisma/client";
import { updateDraftLineItems } from "./draftWrite";

/**
 * Config changes propagate to open Drafts immediately (both PRDs' shared rule):
 *  - a pricebook upload/replace/reorder/delete re-prices every Draft's material lines
 *  - a labor-rate change re-prices every Draft's labor lines
 * Completed quotes are frozen and never touched. Manually edited lines always keep the
 * technician's numbers. Called synchronously from the admin config endpoints.
 * ponytail: synchronous loop over a company's Drafts; queue it if a client ever has
 * thousands of open Drafts.
 */

export async function repriceDrafts(companyId: number): Promise<number> {
  const [pricing, lines] = await Promise.all([
    loadCompanyPricing(companyId),
    prisma.quoteLineItem.findMany({
      where: {
        quote: { companyId, status: "DRAFT" },
        manuallyEdited: false,
        isLabor: false,
      },
    }),
  ]);

  /**
   * Group by payload rather than writing row by row. A sweep gives every line matching a term
   * the same price, and the un-price branch gives them all the same three nulls, so the whole
   * company collapses to a handful of statements instead of one per line — see
   * updateDraftLineItems for why that matters on a pool capped at one connection.
   */
  const batches = new Map<string, { data: Prisma.QuoteLineItemUpdateManyMutationInput; ids: string[] }>();
  const enqueue = (data: Prisma.QuoteLineItemUpdateManyMutationInput, id: string) => {
    const key = JSON.stringify(data);
    const batch = batches.get(key);
    if (batch) batch.ids.push(id);
    else batches.set(key, { data, ids: [id] });
  };

  for (const line of lines) {
    if (line.ambiguousAction) continue; // pending tap-to-select placeholder, not a priced line
    const term = line.searchTerm?.trim() || line.description;
    const hit = pricing.match(term);
    if (hit) {
      if (line.unit && !unitsCompatible(line.unit, hit.unit)) continue;
      const changed =
        line.pricebookCode !== hit.code ||
        Number(line.unitPrice) !== hit.unitPrice ||
        line.sourcePricebookId !== hit.sourcePricebookId;
      if (!changed) continue;
      enqueue(
        {
          unitPrice: hit.unitPrice,
          pricebookCode: hit.code,
          sourcePricebookId: hit.sourcePricebookId,
          ...(hit.unit && line.unit == null ? { unit: hit.unit } : {}),
        },
        line.id
      );
    } else if (line.sourcePricebookId != null) {
      // The line was priced from a book that no longer covers it (item removed, book
      // deleted). Un-price it so the unmatched flag surfaces, rather than keeping a price
      // no configuration stands behind. Fallback-priced (HD-/EST) lines are left alone.
      enqueue({ unitPrice: null, pricebookCode: null, sourcePricebookId: null }, line.id);
    }
  }

  let updated = 0;
  for (const { data, ids } of batches.values())
    updated += await updateDraftLineItems(ids, companyId, data, { manuallyEdited: false });

  if (updated > 0)
    logger.info("Re-priced Draft lines after pricebook config change", { companyId, updated });
  return updated;
}

export async function repriceLaborDrafts(companyId: number): Promise<number> {
  const [rates, lines] = await Promise.all([
    prisma.laborRate.findMany({ where: { companyId } }),
    prisma.quoteLineItem.findMany({
      where: {
        quote: { companyId, status: "DRAFT" },
        isLabor: true,
        laborRateId: { not: null },
        manuallyEdited: false, // an overridden rate is never silently overwritten (US8)
      },
    }),
  ]);
  const byId = new Map(rates.map((r) => [r.id, r]));

  const rateBatches = new Map<string, { hourlyRate: Prisma.Decimal; ids: string[] }>();
  const detachIds: string[] = [];

  for (const line of lines) {
    const rate = byId.get(line.laborRateId!);
    if (rate) {
      if (Number(line.unitPrice) === Number(rate.hourlyRate)) continue;
      const key = String(rate.hourlyRate);
      const batch = rateBatches.get(key);
      if (batch) batch.ids.push(line.id);
      else rateBatches.set(key, { hourlyRate: rate.hourlyRate, ids: [line.id] });
      // Logged where the decision is made, not where it lands: the batched write below
      // reports its own skips. This records what the rate change asked for.
      logger.info("Labor line re-price queued after rate change", {
        companyId,
        lineItemId: line.id,
        from: Number(line.unitPrice),
        to: Number(rate.hourlyRate),
      });
    } else {
      // The configured type was deleted: keep the price the technician already saw, but
      // detach it so it reads as an ad-hoc rate rather than pointing at a dead config row.
      detachIds.push(line.id);
      logger.info("Labor line detach queued: its labor type was deleted", {
        companyId,
        lineItemId: line.id,
      });
    }
  }

  let updated = 0;
  for (const { hourlyRate, ids } of rateBatches.values())
    updated += await updateDraftLineItems(ids, companyId, { unitPrice: hourlyRate }, {
      manuallyEdited: false,
    });
  // Deliberately WITHOUT the manuallyEdited guard the rate writes carry: this clears a pointer
  // to a labor type that no longer exists and touches no money. A technician who overrode the
  // rate keeps their number, and skipping the detach would strand the line on a dead config row.
  updated += await updateDraftLineItems(detachIds, companyId, { laborRateId: null });

  if (updated > 0) logger.info("Re-priced Draft labor lines after a rate change", { companyId, updated });
  return updated;
}
