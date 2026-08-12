import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { callStructured } from "../estimate/estimateService";
import {
  getHomeDepotProduct,
  keysConfigured,
  packQuantityFromTitle,
  searchHomeDepot,
  type HdSearchProduct,
} from "../../lib/serpapi";
import { tokenize } from "./pricebookMatch";
import { packAwareQuantity } from "./packMath";

/**
 * Home Depot catalog resolver for the Estimating Agent.
 *
 * Runs when `matchPricebook()` misses. It NEVER prices a line inline — a cold SerpApi
 * search measured ~13.1s (warm ~0.34s, 5 parallel 14–32s), which would stall the agent
 * turn. Instead:
 *
 *   priceFields() miss  →  line saved unpriced (existing `unmatched` flag)
 *                       →  enqueueResolve() fire-and-forget
 *                       →  resolver writes a PricebookItem row for the company
 *                       →  backfills any unpriced line with the same description
 *                       →  next matchPricebook() hits it with NO API call
 *
 * The pricebook therefore LEARNS: the technician's own phrasing is stored in `synonyms`,
 * so a differently-worded request matches next time. Rows are written `provisional` until
 * a technician accepts the line, because a bad resolve would otherwise become the
 * company's permanent price for that item.
 *
 * Gates, in the order the measurements justify (docs/ESTIMATE_CATALOG_ARCHITECTURE.md §7):
 *   1. unanimity across N query variants — the only reliable "does HD carry this at all"
 *      signal (stocked item: 2 unanimous; unstocked: 0). NOT a correctness signal.
 *   2. spec-token filter + irrigation denylist — the only thing standing between a
 *      real-but-wrong product and the quote, since price-band checking needs a reference
 *      price we do not have for a pricebook miss.
 *   3. LLM picks from TITLES. Never rank by price proximity: a resolver that did scored
 *      2/12, choosing a 4 lb extinguisher for a 10 lb line and an EMT connector for EMT
 *      conduit.
 *   4. one product call on the WINNER only, for price_per_unit — search returns pack price
 *      only, so a 12-pack at $95.99 would otherwise be stored as a $95.99 unit price. That
 *      call is submitted asynchronously (see getHomeDepotProduct); if it still comes back
 *      empty, the same division is done over the search result, whose title states the pack
 *      size — see unitPriceFromSearch.
 */

/**
 * Query variants per item. Measured on the 23 searchTerms real electrical cases produced:
 * average 2.7 unique variants, and only 6 terms were long enough for a cap of 5 to bind at
 * all — so 5→4 trims the tail without weakening unanimity where it does the work. Dropping to
 * 3 saved only 16% of searches while making the absence detector noisy (an unstocked item
 * showed a unanimous match in 7 of 10 three-query subsets, versus 0 at five).
 */
const FANOUT = 4;

/** Brands that mean lawn irrigation — "sprinkler" is irrigation-dominant in HD's index. */
const BRAND_DENYLIST = new Set(["rain bird", "orbit", "melnor", "toro", "hunter"]);

/** In-process de-dupe so a repeated description doesn't queue twice concurrently. */
const inFlight = new Set<string>();

export interface ResolvedCatalogItem {
  code: string;
  unitPrice: number;
  unit: string;
  externalId: string;
  externalLink?: string;
  brand?: string;
  rating?: number;
  packageQuantity?: number;
}

/**
 * Gated on keys alone — the delivery ZIP has a working default (see lib/serpapi.ts), so a
 * SERP_API_KEY_* is the only thing needed to switch the catalog on. With no key configured
 * this is a no-op and pricing behaviour is exactly as it was before the catalog existed.
 */
export function isCatalogEnabled(): boolean {
  return keysConfigured() > 0;
}

/**
 * Deterministic query variants from the technician's own words. Deliberately does NOT
 * trade-qualify (adding "fire"/"sprinkler" measurably degraded results — "sprinkler flow
 * switch" returned irrigation timers) and does NOT use brand+model (HD ignores brand
 * tokens: "Tyco fire sprinkler" returned byte-identical results to "fire sprinkler").
 */
function queryVariants(description: string): string[] {
  const tokens = tokenize(description);
  const core = tokens.join(" ");
  const variants = [
    description.trim(),
    core,
    tokens.slice(0, 4).join(" "),
    tokens.slice(0, 3).join(" "),
    [...tokens].reverse().slice(0, 4).reverse().join(" "),
    // Broadened form: drop the most specific trailing token. Short terms collapse every
    // slice above to the same string — "wire connectors", "ground bar kit" and "ground wire"
    // each produced ONE unique variant, tripped the >= 2 floor, and were rejected before any
    // gate ran. This guarantees a genuinely distinct second query for two-token terms.
    tokens.length > 1 ? tokens.slice(0, -1).join(" ") : "",
  ]
    .map((v) => v.trim())
    .filter((v) => v.length > 2);
  return [...new Set(variants)].slice(0, FANOUT);
}

const SELECT_SCHEMA = {
  name: "catalog_pick",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      productId: {
        type: ["string", "null"],
        description: "product_id of the best match, or null if none genuinely matches.",
      },
      reason: { type: "string" },
    },
    required: ["productId", "reason"],
  },
} as const;

/**
 * The model chooses among VERIFIED candidates and may decline. It never invents a code or
 * a price — that is the whole point of doing selection this way round.
 */
async function pickBest(
  description: string,
  candidates: HdSearchProduct[]
): Promise<HdSearchProduct | null> {
  if (candidates.length === 1) return candidates[0];

  const list = candidates
    .map((c, i) => `${i + 1}. product_id=${c.productId} | ${c.title} | ${c.brand ?? "-"} | $${c.price ?? "?"}`)
    .join("\n");

  try {
    const { raw } = await callStructured({
      system:
        "You match a field technician's material request to a retail product. Pick the ONE " +
        "candidate that matches the request's SPECIFICATION — size, amperage, wattage, " +
        "capacity, weight, rating, length. A near-miss on any spec is a WRONG answer: return " +
        "null instead. Never pick on price. Never pick an accessory (bracket, cover, sign, " +
        "connector, guard) when the request is for the device itself.",
      userContent: `Technician needs: ${description}\n\nCandidates:\n${list}`,
      jsonSchema: SELECT_SCHEMA,
      model: process.env.ORCHESTRATOR_ROUTER_MODEL || "gpt-5.4-mini",
    });
    const id = (raw as any)?.productId;
    if (!id) return null;
    return candidates.find((c) => c.productId === String(id)) ?? null;
  } catch (err) {
    logger.warn("Catalog selection failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Products present in EVERY variant's results — the absence detector. */
function unanimous(resultSets: HdSearchProduct[][]): HdSearchProduct[] {
  if (resultSets.length === 0) return [];
  const counts = new Map<string, { product: HdSearchProduct; n: number }>();
  for (const set of resultSets) {
    for (const id of new Set(set.map((p) => p.productId))) {
      const product = set.find((p) => p.productId === id)!;
      const prev = counts.get(id);
      counts.set(id, { product, n: (prev?.n ?? 0) + 1 });
    }
  }
  return [...counts.values()]
    .filter((c) => c.n === resultSets.length)
    .map((c) => c.product);
}

/**
 * Words that describe SCOPE rather than the product, so their absence from a retail title
 * says nothing. Counting them sank real matches: "20A main breaker" scored 1/3 because
 * "main" is absent from branch-breaker titles, rejecting a correct $7.26 Homeline 20-Amp.
 */
const SCOPE_WORDS = new Set([
  "main", "replacement", "replace", "repair", "install", "installation", "components",
  "component", "assembly", "materials", "material", "misc", "miscellaneous", "consumables",
  "labor", "labour", "existing", "damaged", "affected", "branch", "circuit", "wiring",
  "terminations", "termination", "indoor", "outdoor", "flush", "mount", "surface",
]);

/**
 * Retail titles write units differently from how technicians speak: "20A" vs "20 Amp",
 * "12AWG" vs "12 Gauge", "3/4\"" vs "3/4 in". A literal token test misses all of these, so
 * each token expands into the alternate spellings before matching.
 */
function tokenAliases(t: string): string[] {
  const out = new Set<string>([t]);
  const m = t.match(/^(\d+(?:\.\d+)?)(a|amp|awg|v|volt|w|watt|ga|gauge|lb|lbs|in|ft|p)$/);
  if (m) {
    const [, n, unit] = m;
    const family: Record<string, string[]> = {
      a: ["amp", "amps", "ampere"], amp: ["a", "amps"],
      awg: ["gauge", "ga"], ga: ["gauge", "awg"], gauge: ["awg", "ga"],
      v: ["volt", "volts"], volt: ["v", "volts"],
      w: ["watt", "watts"], watt: ["w", "watts"],
      lb: ["lbs", "pound"], lbs: ["lb", "pound"],
      in: ["inch", "inches"], ft: ["foot", "feet"],
      p: ["pole", "poles"],
    };
    // Only "<n> <unit>" spellings — NEVER the bare number. `title.includes("20")` was
    // satisfied by "120/240-Volt", so a 15 Amp breaker scored 4/4 against a 20A request and
    // gate 2 lost the ability to check the one attribute it exists to check.
    for (const u of [unit, ...(family[unit] ?? [])]) out.add(`${n} ${u}`).add(`${n}-${u}`);
  }
  return [...out];
}

/**
 * Keep candidates whose title covers the request's PRODUCT tokens. Scope words are ignored
 * (see SCOPE_WORDS) and unit spellings are normalised (see tokenAliases), because both were
 * measured rejecting correct products.
 */
function specFilter(description: string, candidates: HdSearchProduct[]): HdSearchProduct[] {
  const wanted = tokenize(description).filter((t) => !SCOPE_WORDS.has(t));
  // Every token is a scope word ("branch circuit wiring") → this names work, not a product.
  // Returning all candidates here made gate 2 a no-op AND skipped the irrigation denylist.
  if (wanted.length === 0) return [];
  return candidates.filter((c) => {
    if (c.brand && BRAND_DENYLIST.has(c.brand.toLowerCase())) return false;
    const title = c.title.toLowerCase();
    const hits = wanted.filter((t) => tokenAliases(t).some((a) => title.includes(a))).length;
    return hits / wanted.length >= 0.5;
  });
}

/**
 * Unit price from the SEARCH result, for when `home_depot_product` returns nothing usable.
 *
 * Historically that was every call: the synchronous engine hung 40–60s with zero bytes,
 * discarding a resolve AFTER three gates had already agreed on a product, which is what left
 * lines unpriced and linkless. Submitting asynchronously fixed that, so this is now a safety
 * net rather than the main path — a resolve should not be discarded because one call of two
 * came back empty.
 *
 * It is not a second opinion on the price: the product endpoint itself returns
 * `price / package_quantity`, and both inputs are present in the search result. Verified
 * against both paths on the same items — HD-100144234 "(5-Pack)" $2.95 → $0.59 and
 * HD-316097627 "(50-Pack)" $17.48 → $0.35, each matching the endpoint's own price_per_unit.
 */
function unitPriceFromSearch(
  product: HdSearchProduct
): { unitPrice: number; packageQuantity: number } | null {
  const price = product.price;
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  const packageQuantity = packQuantityFromTitle(product.title);
  if (packageQuantity == null) return null;
  const unitPrice = Math.round((price / packageQuantity) * 100) / 100;
  return unitPrice > 0 ? { unitPrice, packageQuantity } : null;
}

/**
 * Resolve one description against Home Depot and persist it to the company's pricebook.
 * Returns the resolved item, or null when HD does not stock it (the honest outcome — the
 * line simply stays unpriced for the technician to fill in).
 */
export async function resolveFromHomeDepot(
  description: string,
  companyId: number
): Promise<ResolvedCatalogItem | null> {
  if (!isCatalogEnabled()) return null;

  const variants = queryVariants(description);
  if (variants.length === 0) return null;

  const resultSets = (
    await Promise.all(
      variants.map((q) =>
        searchHomeDepot(q).catch((err) => {
          logger.warn("Catalog search failed", { q, error: err?.message });
          return [] as HdSearchProduct[];
        })
      )
    )
  ).filter((s) => s.length > 0);

  // With a single result set, unanimity is trivially satisfied and gate 1 becomes a no-op —
  // gates 2 (spec tokens) and 3 (model selection) still carry the correctness load. Better to
  // proceed with the absence check skipped than to reject an item outright, which is what the
  // old `< 2` floor did to every two-token term.
  if (resultSets.length === 0) return null;
  if (resultSets.length === 1) {
    // Distinguish "only one variant existed" (the intended relaxation for short two-token
    // terms) from "the other searches failed". Conflating them made gate 1 strictly MORE
    // permissive the worse the upstream was behaving — the opposite of what a guard should do.
    if (variants.length > 1) {
      logger.warn("Catalog: searches failed, declining to price without the absence check", {
        description,
        variants: variants.length,
        succeeded: resultSets.length,
      });
      return null;
    }
    logger.info("Catalog: single query variant, absence check skipped", { description });
  }

  // GATE 1 — absence detector.
  const agreed = unanimous(resultSets);
  if (agreed.length === 0) {
    logger.info("Catalog: not stocked", { description, variants: resultSets.length });
    return null;
  }

  // GATE 2 — spec tokens + brand denylist.
  const filtered = specFilter(description, agreed);
  if (filtered.length === 0) {
    logger.info("Catalog: no candidate matched the spec tokens", { description });
    return null;
  }

  // GATE 3 — model picks among verified candidates, and may decline.
  const winner = await pickBest(description, filtered.slice(0, 8));
  if (!winner) {
    logger.info("Catalog: selection declined", { description, candidates: filtered.length });
    return null;
  }

  // GATE 4 — per-unit economics. Search gives pack price only.
  const detail = await getHomeDepotProduct(winner.productId).catch((err) => {
    logger.warn("Catalog product lookup failed", { productId: winner.productId, error: err?.message });
    return null;
  });
  // The product endpoint is authoritative when it answers. When it doesn't, fall back to the
  // same arithmetic over the search result rather than throwing away three passing gates.
  const fromSearch = detail?.unitPrice == null ? unitPriceFromSearch(winner) : null;
  const unitPrice = detail?.unitPrice ?? fromSearch?.unitPrice;
  if (unitPrice == null || !Number.isFinite(unitPrice) || unitPrice <= 0) {
    logger.info("Catalog: no usable unit price", { productId: winner.productId });
    return null;
  }
  if (fromSearch) {
    logger.info("Catalog: priced from search, product endpoint unavailable", {
      productId: winner.productId,
      unitPrice,
      packageQuantity: fromSearch.packageQuantity,
    });
  }
  if (detail?.availability && /out|unavailable|discontinued/i.test(detail.availability)) {
    logger.info("Catalog: winner unavailable", { productId: winner.productId });
    return null;
  }

  // Pack size decides whether a line's count gets rounded up, so take it from whichever
  // source has it: the product record, the search fallback, or the title itself — a response
  // carrying price_per_unit but no package_quantity would otherwise look like a single item.
  const packQty =
    detail?.packageQuantity ??
    fromSearch?.packageQuantity ??
    packQuantityFromTitle(detail?.title || winner.title) ??
    undefined;

  const code = `HD-${winner.productId}`;
  const unit = detail?.unit && detail.unit !== "unit" ? detail.unit : "EA";
  const title = detail?.title || winner.title;

  // Persist company-scoped so matchPricebook() finds it next turn with no API call. The
  // technician's own phrasing goes into synonyms so different wording still matches.
  try {
    const existing = await prisma.pricebookItem.findUnique({
      where: { companyId_code: { companyId, code } },
      select: { synonyms: true },
    });
    const synonyms = [...new Set([...(existing?.synonyms ?? []), description.trim()])];

    await prisma.pricebookItem.upsert({
      where: { companyId_code: { companyId, code } },
      create: {
        companyId,
        code,
        description: title,
        unit,
        unitPrice,
        synonyms,
        source: "HOME_DEPOT",
        provisional: true,
        externalId: winner.productId,
        externalLink: detail?.link ?? winner.link,
        brand: detail?.brand ?? winner.brand,
        rating: winner.rating ?? detail?.rating,
        packageQuantity: packQty,
        lastResolvedAt: new Date(),
      },
      update: {
        unitPrice,
        unit,
        synonyms,
        externalLink: detail?.link ?? winner.link,
        rating: winner.rating ?? detail?.rating,
        packageQuantity: packQty,
        lastResolvedAt: new Date(),
      },
    });
  } catch (err) {
    // Persistence is a precondition of pricing. Returning a price whose pricebook row does not
    // exist left the line with an HD- code that no future resolve could repair (all three OR
    // arms of the backfill go false), no product provenance in the DTO, and a re-resolve on
    // every later turn. Leaving it unpriced is recoverable; a dangling code is not.
    logger.error("Catalog upsert failed; refusing to price the line", {
      code,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  logger.info("Catalog resolved", { description, code, unitPrice, brand: winner.brand });

  return {
    code,
    unitPrice,
    unit,
    externalId: winner.productId,
    externalLink: detail?.link ?? winner.link,
    brand: detail?.brand ?? winner.brand,
    rating: winner.rating ?? detail?.rating,
    packageQuantity: packQty,
  };
}

/**
 * Fire-and-forget resolve + backfill. Called from the agent turn on a pricebook miss so
 * the turn itself stays fast. After resolving it prices every still-unpriced line in the
 * company's open quotes that carries this description, so the `unmatched` flag clears on
 * its own (flags are derived, so nothing else has to be updated).
 */
export function enqueueResolve(
  searchTerm: string,
  companyId: number,
  /** The line's human-readable description, kept only for logging and synonyms. */
  lineDescription?: string,
  /**
   * The specific line item(s) this resolve is for. The backfill updates ONLY these rows.
   *
   * Previously the backfill matched on `description` string equality across every DRAFT quote
   * in the company, which four independent reviewers flagged: two lines sharing a description
   * but resolving different searchTerms would each overwrite the other (whichever SerpApi call
   * returned first won, and the loser silently displayed the wrong product's price and link),
   * and one technician's turn mutated prices on colleagues' in-progress quotes.
   */
  lineItemIds?: string[]
): void {
  if (!isCatalogEnabled()) return;
  // Keyed on the term AND the target, so two lines wanting the same part both get priced —
  // keying on the term alone silently dropped the second line's enqueue and left it blank
  // forever, since priceFields never re-runs for an existing row.
  const key = `${companyId}::${searchTerm.trim().toLowerCase()}::${(lineItemIds ?? []).join(",")}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);

  void (async () => {
    try {
      const resolved = await resolveFromHomeDepot(searchTerm, companyId);
      if (!resolved) return;

      // Update ONLY the line(s) this resolve was started for. With no ids there is nothing
      // safe to target — matching on description text sprayed one product's price across
      // every same-description line in the company — so skip the backfill entirely and let
      // the next turn pick the price up from the cache.
      if (!lineItemIds || lineItemIds.length === 0) {
        logger.info("Catalog resolved but no target line ids; cached only", { searchTerm });
        return;
      }

      // Home Depot is the price source for every material line, so this also OVERRIDES a
      // placeholder taken from the company's own book (any code not prefixed HD-). Without
      // that, priceFields showing a MANUAL price while the resolve ran would leave
      // `unitPrice` non-null and this update would skip the row, pinning the book price
      // forever. A technician's own edit always wins — manuallyEdited rows are never touched.
      const targets = await prisma.quoteLineItem.findMany({
        where: {
          id: { in: lineItemIds },
          manuallyEdited: false,
          quote: { companyId, status: "DRAFT" },
          OR: [
            { unitPrice: null },
            { pricebookCode: null },
            { NOT: { pricebookCode: { startsWith: "HD-" } } },
          ],
        },
        select: { id: true, quantity: true, unit: true },
      });

      // Per row rather than updateMany: rounding a count up to a whole pack is arithmetic on
      // each line's own quantity, which a single bulk statement cannot express. The target
      // list is one or two ids, so the extra queries are immaterial.
      let count = 0;
      for (const row of targets) {
        const unit = resolved.unit ?? row.unit;
        const packed = packAwareQuantity(
          row.quantity == null ? null : Number(row.quantity),
          unit,
          resolved.packageQuantity
        );
        await prisma.quoteLineItem.update({
          where: { id: row.id },
          data: {
            unitPrice: resolved.unitPrice,
            unit: resolved.unit,
            pricebookCode: resolved.code,
            ...(packed.rounded ? { quantity: packed.quantity } : {}),
          },
        });
        count++;
        if (packed.rounded)
          logger.info("Backfill rounded quantity up to a whole pack", {
            lineItemId: row.id,
            from: Number(row.quantity),
            to: packed.quantity,
            packageQuantity: resolved.packageQuantity,
          });
      }
      if (count > 0) logger.info("Catalog backfilled unpriced lines", { searchTerm, count });
    } catch (err) {
      logger.warn("Catalog resolve job failed", {
        searchTerm,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inFlight.delete(key);
    }
  })();
}
