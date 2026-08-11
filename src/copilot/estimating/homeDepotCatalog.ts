import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { callStructured } from "../estimate/estimateService";
import {
  getHomeDepotProduct,
  keysConfigured,
  searchHomeDepot,
  type HdSearchProduct,
} from "../../lib/serpapi";
import { tokenize } from "./pricebookMatch";

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
 *      only, so a 12-pack at $95.99 would otherwise be stored as a $95.99 unit price.
 */

/** Query variants per item. 5 separated cleanly in testing; 2 gave no absence signal. */
const FANOUT = 5;

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
  const m = t.match(/^(\d+(?:\.\d+)?)(a|amp|awg|v|volt|w|watt|ga|gauge|lb|lbs|in|ft)$/);
  if (m) {
    const [, n, unit] = m;
    const family: Record<string, string[]> = {
      a: ["amp", "amps", "ampere"], amp: ["a", "amps"],
      awg: ["gauge", "ga"], ga: ["gauge", "awg"], gauge: ["awg", "ga"],
      v: ["volt", "volts"], volt: ["v", "volts"],
      w: ["watt", "watts"], watt: ["w", "watts"],
      lb: ["lbs", "pound"], lbs: ["lb", "pound"],
      in: ["inch", "inches"], ft: ["foot", "feet"],
    };
    // Both the bare number and every "<n> <unit>" spelling — titles hyphenate or space them,
    // and tokenize() drops bare digits, so the number alone must be matched as a substring.
    out.add(n);
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
  if (wanted.length === 0) return candidates;
  return candidates.filter((c) => {
    if (c.brand && BRAND_DENYLIST.has(c.brand.toLowerCase())) return false;
    const title = c.title.toLowerCase();
    const hits = wanted.filter((t) => tokenAliases(t).some((a) => title.includes(a))).length;
    return hits / wanted.length >= 0.5;
  });
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

  if (resultSets.length < 2) return null; // not enough signal to judge absence

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
  const unitPrice = detail?.unitPrice ?? undefined;
  if (unitPrice == null || !Number.isFinite(unitPrice) || unitPrice <= 0) {
    logger.info("Catalog: no usable unit price", { productId: winner.productId });
    return null;
  }
  if (detail?.availability && /out|unavailable|discontinued/i.test(detail.availability)) {
    logger.info("Catalog: winner unavailable", { productId: winner.productId });
    return null;
  }

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
        packageQuantity: detail?.packageQuantity,
        lastResolvedAt: new Date(),
      },
      update: {
        unitPrice,
        unit,
        synonyms,
        externalLink: detail?.link ?? winner.link,
        rating: winner.rating ?? detail?.rating,
        packageQuantity: detail?.packageQuantity,
        lastResolvedAt: new Date(),
      },
    });
  } catch (err) {
    logger.warn("Catalog upsert failed", {
      code,
      error: err instanceof Error ? err.message : String(err),
    });
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
    packageQuantity: detail?.packageQuantity,
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
  /** The line's human-readable description, so the backfill can find the row it came from. */
  lineDescription?: string
): void {
  if (!isCatalogEnabled()) return;
  const key = `${companyId}::${searchTerm.trim().toLowerCase()}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);

  void (async () => {
    try {
      const resolved = await resolveFromHomeDepot(searchTerm, companyId);
      if (!resolved) return;

      // Backfill by the line's own description — the searchTerm is a catalog name and won't
      // equal what is stored on the row.
      const { count } = await prisma.quoteLineItem.updateMany({
        where: {
          description: lineDescription ?? searchTerm,
          unitPrice: null,
          totalPrice: null,
          manuallyEdited: false,
          quote: { companyId, status: "DRAFT" },
        },
        data: {
          unitPrice: resolved.unitPrice,
          unit: resolved.unit,
          pricebookCode: resolved.code,
        },
      });
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
