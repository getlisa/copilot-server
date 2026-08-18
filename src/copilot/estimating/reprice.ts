import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { loadCompanyPricing } from "./companyPricing";
import { unitsCompatible } from "./packMath";

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
        labor: false,
      },
    }),
  ]);

  let updated = 0;
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
      await prisma.quoteLineItem.update({
        where: { id: line.id },
        data: {
          unitPrice: hit.unitPrice,
          pricebookCode: hit.code,
          sourcePricebookId: hit.sourcePricebookId,
          ...(hit.unit && line.unit == null ? { unit: hit.unit } : {}),
        },
      });
      updated++;
    } else if (line.sourcePricebookId != null) {
      // The line was priced from a book that no longer covers it (item removed, book
      // deleted). Un-price it so the unmatched flag surfaces, rather than keeping a price
      // no configuration stands behind. Fallback-priced (HD-/EST) lines are left alone.
      await prisma.quoteLineItem.update({
        where: { id: line.id },
        data: { unitPrice: null, pricebookCode: null, sourcePricebookId: null },
      });
      updated++;
    }
  }
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
        labor: true,
        laborRateId: { not: null },
        manuallyEdited: false, // an overridden rate is never silently overwritten (US8)
      },
    }),
  ]);
  const byId = new Map(rates.map((r) => [r.id, r]));

  let updated = 0;
  for (const line of lines) {
    const rate = byId.get(line.laborRateId!);
    if (rate) {
      if (Number(line.unitPrice) === Number(rate.hourlyRate)) continue;
      await prisma.quoteLineItem.update({
        where: { id: line.id },
        data: { unitPrice: rate.hourlyRate },
      });
      logger.info("Labor line re-priced after rate change", {
        companyId,
        lineItemId: line.id,
        from: Number(line.unitPrice),
        to: Number(rate.hourlyRate),
      });
    } else {
      // The configured type was deleted: keep the price the technician already saw, but
      // detach it so it reads as an ad-hoc rate rather than pointing at a dead config row.
      await prisma.quoteLineItem.update({
        where: { id: line.id },
        data: { laborRateId: null },
      });
      logger.info("Labor line detached from deleted labor type", {
        companyId,
        lineItemId: line.id,
      });
    }
    updated++;
  }
  return updated;
}
