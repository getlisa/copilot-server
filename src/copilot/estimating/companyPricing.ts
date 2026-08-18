import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { matchPricebook, dedupeSharedRows } from "./pricebookMatch";
import { PricebookItem } from "@prisma/client";

/**
 * Per-client pricing pool (pricebook-config PRD).
 *
 * Order of authority, replacing the old "Home Depot prices everything" model:
 *   1. The client's own named pricebooks, checked in priority order. When the same term
 *      matches in more than one book at different prices, the HIGHER price wins regardless
 *      of priority; priority breaks exact-price ties and decides which book is shown as the
 *      source (US1).
 *   2. Legacy MANUAL rows with no pricebook (pre-PRD seed data) act as one implicit,
 *      lowest-priority book so existing companies keep working unchanged.
 *   3. The Home Depot cache and live resolver run ONLY when the client's fallback toggle is
 *      on (US5, off by default) — a pricebook hit is never overridden by Home Depot.
 */

export interface MatchableRow {
  id: number;
  code: string;
  description: string;
  unit: string;
  unitPrice: number;
  synonyms: string[];
  packageQuantity: number | null;
}

export interface PricedMatch extends MatchableRow {
  /** Named book the price came from; null = legacy manual rows or the HD cache. */
  sourcePricebookId: number | null;
  /** Book name for the review screen's price-source display. */
  sourceName: string | null;
  fromHdCache: boolean;
}

export interface CompanyPricing {
  fallbackEnabled: boolean;
  /** Books → legacy manual → (HD cache when fallback is on). Null = nothing matched. */
  match(term: string): PricedMatch | null;
  /** Every own row by code, for explicit KB code lookups. */
  byCode: Map<string, PricedMatch>;
  /** The deduped underlying rows, for product-provenance maps (turn context, DTOs). */
  rawRows: PricebookItem[];
}

const toRow = (p: PricebookItem): MatchableRow => ({
  id: p.id,
  code: p.code,
  description: p.description,
  unit: p.unit,
  unitPrice: Number(p.unitPrice),
  synonyms: p.synonyms,
  packageQuantity: p.packageQuantity == null ? null : Number(p.packageQuantity),
});

export async function hdFallbackEnabledFor(companyId: number): Promise<boolean> {
  const config = await prisma.company_configs.findUnique({
    where: { company_id: companyId },
    select: { hd_fallback_enabled: true },
  });
  return config?.hd_fallback_enabled === true;
}

export async function loadCompanyPricing(companyId: number): Promise<CompanyPricing> {
  const [books, rows, fallbackEnabled] = await Promise.all([
    prisma.pricebook.findMany({ where: { companyId }, orderBy: { priority: "asc" } }),
    // Own rows in full, plus other companies' accepted HD cache rows — a cached retail
    // price is the same number for everyone (see pricebookRowsFor's rationale).
    prisma.pricebookItem.findMany({
      where: { OR: [{ companyId }, { source: "HOME_DEPOT", provisional: false }] },
    }),
    hdFallbackEnabledFor(companyId),
  ]);
  const deduped = dedupeSharedRows(rows, companyId);

  const byBookId = new Map<number, MatchableRow[]>();
  const legacyManual: MatchableRow[] = [];
  const hdCache: MatchableRow[] = [];
  for (const row of deduped) {
    if (row.source === "HOME_DEPOT") hdCache.push(toRow(row));
    else if (row.pricebookId != null) {
      const list = byBookId.get(row.pricebookId) ?? [];
      list.push(toRow(row));
      byBookId.set(row.pricebookId, list);
    } else legacyManual.push(toRow(row));
  }

  // Named books in priority order, then the implicit legacy book last.
  const pools: { id: number | null; name: string | null; items: MatchableRow[] }[] = [
    ...books.map((b) => ({ id: b.id, name: b.name, items: byBookId.get(b.id) ?? [] })),
    ...(legacyManual.length > 0 ? [{ id: null, name: null, items: legacyManual }] : []),
  ];

  const byCode = new Map<string, PricedMatch>();
  for (const pool of pools) {
    for (const row of pool.items) {
      if (!byCode.has(row.code))
        byCode.set(row.code, {
          ...row,
          sourcePricebookId: pool.id,
          sourceName: pool.name,
          fromHdCache: false,
        });
    }
  }

  const match = (term: string) => matchPools(term, pools, hdCache, fallbackEnabled, companyId);

  return { fallbackEnabled, match, byCode, rawRows: deduped };
}

export interface MatchPool {
  id: number | null;
  name: string | null;
  items: MatchableRow[];
}

/**
 * The PRD's matching order and collision rule, pure for testability: pools must already be
 * in priority order; higher price wins a cross-book collision; the first of an exact price
 * tie (= the higher-priority book) is shown as the source; the HD cache is consulted only
 * when fallback is enabled and no book matched.
 */
export function matchPools(
  term: string,
  pools: MatchPool[],
  hdCache: MatchableRow[],
  fallbackEnabled: boolean,
  companyId?: number
): PricedMatch | null {
  // One candidate per book (its best match), collected across every book so the
  // collision rule can compare prices between books.
  const hits = pools.flatMap((pool) => {
    const hit = matchPricebook(term, pool.items);
    return hit ? [{ pool, hit }] : [];
  });
  if (hits.length > 0) {
    // Higher price wins a collision; pools are already in priority order, so the first
    // of an exact price tie is the higher-priority book (US1).
    const winner = hits.reduce((a, b) => (b.hit.unitPrice > a.hit.unitPrice ? b : a));
    if (hits.length > 1)
      logger.info("Pricebook collision resolved (higher price wins)", {
        companyId,
        term,
        candidates: hits.map((h) => ({
          book: h.pool.name ?? "(legacy)",
          code: h.hit.code,
          unitPrice: h.hit.unitPrice,
        })),
        winner: winner.pool.name ?? "(legacy)",
      });
    return {
      ...winner.hit,
      sourcePricebookId: winner.pool.id,
      sourceName: winner.pool.name,
      fromHdCache: false,
    };
  }
  if (!fallbackEnabled) return null;
  const cached = matchPricebook(term, hdCache);
  return cached
    ? { ...cached, sourcePricebookId: null, sourceName: null, fromHdCache: true }
    : null;
}
