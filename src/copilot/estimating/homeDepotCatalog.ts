import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { callStructured } from "../estimate/estimateService";
import {
  getHomeDepotProduct,
  keysConfigured,
  lengthFromTitle,
  packQuantityFromTitle,
  searchHomeDepot,
  type HdSearchProduct,
} from "../../lib/serpapi";
import { tokenize } from "./pricebookMatch";
import { isLengthUnit, packAwareQuantity, unitsCompatible } from "./packMath";
import { lookupHomeDepotViaWebSearch } from "./modelPriceEstimate";
import { ESTIMATED_PRICE_CODE } from "./quoteDto";

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

/**
 * Total resolve attempts per term (the first try + up to 2 retries) before giving up for
 * good, and the per-term attempt ledger backing it. A resolve fails for transient reasons —
 * SerpApi queueing, timeouts, an unlucky async poll — as readily as for "HD doesn't stock
 * it", and a single silent failure used to leave the line unpriced forever. Each item
 * retries individually through the same one-at-a-time resolve queue. The ledger is
 * in-memory: a restart grants a fresh set of attempts, which is the desired behavior for
 * transient outages.
 */
const MAX_RESOLVE_ATTEMPTS = 3;
const resolveAttempts = new Map<string, { n: number; at: number }>();

/**
 * An exhausted ledger entry goes stale after this long and the term earns a fresh set of
 * attempts. Exhaustion used to be permanent until restart, which turned a burst of SerpApi
 * congestion into "this item can never be priced" — a technician re-asking an hour later got
 * silence for a stocked $9 light bulb. Unstocked items still cost at most 3 searches per
 * window instead of 3 ever, which is the right trade.
 */
const RESOLVE_LEDGER_TTL_MS = 15 * 60_000;

function takeResolveAttempt(key: string): number | null {
  const entry = resolveAttempts.get(key);
  const now = Date.now();
  const fresh = entry && now - entry.at <= RESOLVE_LEDGER_TTL_MS ? entry : undefined;
  if (fresh && fresh.n >= MAX_RESOLVE_ATTEMPTS) return null;
  const n = (fresh?.n ?? 0) + 1;
  resolveAttempts.set(key, { n, at: now });
  return n;
}

/**
 * Wait before each RETRY (not the first attempt): 30s, then 60s. A full quote fires a dozen
 * resolves at once and SerpApi's free tier queues past ~5 parallel searches (measured
 * 14-32s stalls), so an immediate retry lands inside the same congestion that failed the
 * first attempt and the whole ledger burns in seconds — measured on a 13-line quote where
 * only the first 3 items priced. Spacing the retries lets the burst drain first.
 */
const RETRY_BACKOFF_MS = 30_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
/**
 * Vocabulary HD titles abbreviate that technicians spell out. Measured on "4/0 AWG aluminum
 * XHHW wire": the right product is titled "4/0-4/0-4/0-2/0 Gray Stranded AL SER Cable" —
 * "aluminum" and "wire" both scored 0 and the spec filter rejected every candidate for a
 * stocked item. Short aliases ("al", "cu") are matched as whole words, see wordRe.
 */
const WORD_ALIASES: Record<string, string[]> = {
  aluminum: ["al"], copper: ["cu"], wire: ["cable"], cable: ["wire"],
};

function tokenAliases(t: string): string[] {
  const out = new Set<string>([t]);
  for (const a of WORD_ALIASES[t] ?? []) out.add(a);
  const m = t.match(/^(\d+(?:\.\d+)?)(a|amp|awg|hp|v|volt|w|watt|ga|gauge|lb|lbs|in|ft|p)$/);
  if (m) {
    const [, n, unit] = m;
    const family: Record<string, string[]> = {
      a: ["amp", "amps", "ampere"], amp: ["a", "amps"],
      awg: ["gauge", "ga"], ga: ["gauge", "awg"], gauge: ["awg", "ga"],
      v: ["volt", "volts"], volt: ["v", "volts"],
      w: ["watt", "watts"], watt: ["w", "watts"],
      lb: ["lbs", "pound"], lbs: ["lb", "pound"],
      in: ["inch", "inches"], ft: ["foot", "feet"],
      p: ["pole", "poles"], hp: ["horsepower"],
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
    // HD writes aught gauges with a stray space — "4 /0-4 /0-2/0" — which no request ever
    // contains; collapse it so the "4/0" spec token can hit.
    const title = c.title.toLowerCase().replace(/(\d)\s+\/\s*0/g, "$1/0");
    const hits = wanted.filter((t) =>
      tokenAliases(t).some((a) => (a.length <= 3 ? wordRe(a).test(title) : title.includes(a)))
    ).length;
    return hits / wanted.length >= 0.5;
  });
}

/**
 * Whole-word test for short aliases. "al" as a substring matches "metallic" and
 * "galvanized"; as a word it matches only HD's abbreviation ("Stranded AL SER Cable").
 */
function wordRe(alias: string): RegExp {
  return new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\b`, "i");
}

/**
 * Goods genuinely sold by length, where footage in the title is the amount one purchase
 * buys. Deliberately narrow: "cord" is absent because a "100 ft. extension cord" is one
 * item, and tools that merely mention a length ("25 ft. tape measure") must not match.
 */
const SOLD_BY_LENGTH_RE =
  /\b(wire|cable|conduit|romex|nm-b|thhn|uf-b|pex|tubing|tube|hose|rope|chain)\b/i;

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
 * FIFO semaphore capping concurrent resolves. A confirmed 8-item proposal used to fire
 * 8 resolves × 4 search variants = ~32 simultaneous SerpApi searches; the free tier queues
 * past ~5 parallel, everything slowed to 15–30s, and most lines went unpriced. Two resolves
 * (≤8 searches in flight) stay inside what SerpApi serves promptly.
 */
const MAX_CONCURRENT_RESOLVES = 2;
let activeResolves = 0;
const resolveWaiters: Array<() => void> = [];

async function acquireResolveSlot(): Promise<void> {
  if (activeResolves < MAX_CONCURRENT_RESOLVES) {
    activeResolves++;
    return;
  }
  await new Promise<void>((wake) => resolveWaiters.push(wake));
}

function releaseResolveSlot(): void {
  const next = resolveWaiters.shift();
  if (next) next(); // slot handed to the waiter; activeResolves unchanged
  else activeResolves--;
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
  await acquireResolveSlot();
  try {
    return await resolveThrottled(description, companyId);
  } finally {
    releaseResolveSlot();
  }
}

const CANONICAL_TERM_SCHEMA = {
  name: "catalog_term",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      term: {
        type: ["string", "null"],
        description:
          "The retail product name a supplier would list, or null if nothing purchasable is named.",
      },
    },
    required: ["term"],
  },
} as const;

/**
 * Rewrite a failed search term into the name Home Depot actually lists the product under.
 *
 * The terms that reach the resolver are often the technician's (or the agent's) scope
 * language — "EV charger mounting hardware / connection materials", "conduit and fittings
 * for EV charger circuit" — which HD's index cannot match, so every gate correctly rejects
 * and the line stays unpriced forever. Measured on three real quotes: 11 of 13 lines were
 * unmatchable scope text. One cheap structured call turns that into a listable product name
 * ("3/4 in EMT conduit"), which is retried once. Null means the model judged there is
 * nothing purchasable behind the words — the honest outcome, same as an unstocked item.
 */
async function canonicalSearchTerm(description: string): Promise<string | null> {
  try {
    const { raw } = await callStructured({
      // Example-driven on purpose: a rules-only prompt returned null for every bundle-ish
      // line ("conduit and fittings for EV charger circuit") instead of naming the primary
      // product — measured 0 of 4 usable terms; with the examples, 6 of 6.
      system:
        "You turn a field-service line item into the retail search term that finds the product at a supplier like Home Depot.\n" +
        "Rules:\n" +
        "- Name ONE purchasable product: the product noun plus the spec that identifies it (size, amperage, gauge, voltage, capacity). Infer a sensible spec from trade context when unstated.\n" +
        "- A description covering several parts names its PRIMARY product (the most expensive one), never a bundle phrase.\n" +
        "- No scope words: install, replacement, repair, run, circuit, materials, as needed.\n" +
        "- Name the FORM the retailer stocks, not the spec-sheet name: residential feeder conductors sell as SER/URD cable assemblies, not single XHHW conductors.\n" +
        "- Return null ONLY when the line is purely labor, diagnosis, or testing with nothing to buy.\n" +
        "Examples:\n" +
        '- "4/0 AWG aluminum XHHW wire" -> "4/0-4/0-4/0-2/0 aluminum SER cable"\n' +
        '- "Conduit and fittings for EV charger circuit" -> "3/4 in EMT conduit"\n' +
        '- "EV charger dedicated branch circuit wiring, 50-100 ft run" -> "6 AWG THHN wire"\n' +
        '- "Accessible junction box(es) and cover(s), as needed" -> "4 in square junction box"\n' +
        '- "Troubleshoot short and re-terminate conductors" -> null',
      userContent: `Line item: ${description}`,
      jsonSchema: CANONICAL_TERM_SCHEMA,
      model: process.env.ORCHESTRATOR_ROUTER_MODEL || "gpt-5.4-mini",
    });
    const term = (raw as { term?: unknown } | null)?.term;
    if (typeof term !== "string") return null;
    const trimmed = term.trim();
    // Models sometimes emit the WORD null instead of the JSON value — never search for it.
    return trimmed && !/^(null|none|n\/a)$/i.test(trimmed) ? trimmed : null;
  } catch (err) {
    logger.warn("Catalog term canonicalization failed", {
      description,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Gates 1-3 for one term: search variants → unanimity → spec filter → model pick. */
async function searchAndPick(description: string): Promise<HdSearchProduct | null> {
  const variants = queryVariants(description);
  if (variants.length === 0) return null;

  const firstPass = await Promise.allSettled(variants.map((q) => searchHomeDepot(q)));
  const sets: (HdSearchProduct[] | null)[] = firstPass.map((settled, i) => {
    if (settled.status === "rejected") {
      logger.warn("Catalog search failed", {
        q: variants[i],
        error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
      });
      return null;
    }
    return settled.value;
  });

  // Failed variants get ONE more sequential try after the burst. SerpApi's free tier queues
  // past ~5 parallel searches, so a variant that timed out inside the fan-out routinely
  // succeeds alone moments later — measured live on "A19 standard light bulb", where 1 of 3
  // variants timed out on an otherwise idle run. Sequential on purpose: re-firing the
  // failures in parallel lands them back in the congestion that failed them.
  for (let i = 0; i < variants.length; i++) {
    if (sets[i] !== null) continue;
    try {
      sets[i] = await searchHomeDepot(variants[i]);
    } catch {
      // already logged above; leave null
    }
  }
  const resultSets = sets.filter((s): s is HdSearchProduct[] => s !== null && s.length > 0);

  // With a single result set, unanimity is trivially satisfied and gate 1 becomes a no-op —
  // gates 2 (spec tokens) and 3 (model selection) still carry the correctness load. Better to
  // proceed with the absence check skipped than to reject the item outright: declining on
  // partial search failure meant a transient timeout guaranteed an unpriced line ("A19
  // standard light bulb" burned its whole retry ledger this way), which is a worse failure
  // than one resolve running without the absence signal.
  if (resultSets.length === 0) return null;
  if (resultSets.length === 1) {
    logger.info("Catalog: single result set, absence check skipped", {
      description,
      variants: variants.length,
    });
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
  return winner;
}

async function resolveThrottled(
  description: string,
  companyId: number
): Promise<ResolvedCatalogItem | null> {
  let winner = await searchAndPick(description);
  if (!winner) {
    // Natural-language terms fail HD's index even when the product is stocked. Rewrite once
    // into a listable product name and retry — see canonicalSearchTerm.
    const canonical = await canonicalSearchTerm(description);
    if (canonical && canonical.toLowerCase() !== description.trim().toLowerCase()) {
      logger.info("Catalog: retrying with canonicalized term", { description, canonical });
      winner = await searchAndPick(canonical);
    }
  }
  if (!winner) return null;

  // GATE 4 — per-unit economics. Search gives pack price only.
  const detail = await getHomeDepotProduct(winner.productId).catch((err) => {
    logger.warn("Catalog product lookup failed", { productId: winner.productId, error: err?.message });
    return null;
  });
  // The product endpoint is authoritative when it answers. When it doesn't, fall back to the
  // same arithmetic over the search result rather than throwing away three passing gates.
  const fromSearch = detail?.unitPrice == null ? unitPriceFromSearch(winner) : null;
  let unitPrice = detail?.unitPrice ?? fromSearch?.unitPrice;
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
  let packQty =
    detail?.packageQuantity ??
    fromSearch?.packageQuantity ??
    packQuantityFromTitle(detail?.title || winner.title) ??
    undefined;

  const code = `HD-${winner.productId}`;
  let unit = detail?.unit && detail.unit !== "unit" ? detail.unit : "EA";
  const title = detail?.title || winner.title;

  // ── Price-basis normalization ─────────────────────────────────────────────────────────
  // ROOT RULE: when the listing price and the units one purchase buys (pack count or roll
  // length) are both known, the stored per-unit price is listingPrice / unitsPerPurchase —
  // DERIVED, never read off a label. SerpApi's labels lie in both directions: unit "ft."
  // next to the whole-spool price (price_per_unit absent) stored $144/ft for a 500 ft THHN
  // spool and quoted a 2,000 ft line at $288,000; a price_per_unit equal to the pack price
  // does the same for count packs. The division cannot lie — both inputs describe the same
  // purchase.
  //
  // Cable, conduit and the like sell in fixed lengths: "100 ft. 14/2 NM-B" is ONE $47 roll,
  // not 100 things. Those store the per-foot price with the roll length as the pack size, so
  // a 25 ft line rounds up to the whole 100 ft the technician actually has to buy — the same
  // arithmetic as four connectors from a 5-pack. Gated on goods genuinely sold by length so
  // a "25 ft. tape measure" never becomes per-foot pricing.
  const rollLength = lengthFromTitle(title);
  const soldByLength =
    rollLength != null &&
    rollLength > 1 &&
    (packQty == null || packQty <= 1) &&
    SOLD_BY_LENGTH_RE.test(title);
  const unitsPerPurchase = soldByLength ? rollLength : packQty ?? 1;
  const listingPrice = detail?.price ?? winner.price;
  if (unitsPerPurchase > 1) {
    if (listingPrice != null && listingPrice > 0) {
      unitPrice = Math.round((listingPrice / unitsPerPurchase) * 100) / 100;
    } else if (soldByLength && !isLengthUnit(unit)) {
      // No listing price to derive from, so the unit label is all there is: a count label
      // on a sold-by-length listing means the reported price is the whole roll — convert.
      unitPrice = Math.round((unitPrice / rollLength) * 100) / 100;
    }
    if (soldByLength) {
      unit = "ft";
      packQty = rollLength;
      logger.info("Catalog: sold by length, priced per ft with whole-roll rounding", {
        productId: winner.productId,
        rollLength,
        unitPrice,
      });
    }
  }
  if (unitPrice <= 0) {
    logger.info("Catalog: no usable unit price after normalization", {
      productId: winner.productId,
    });
    return null;
  }

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
/**
 * Last resort when the catalog API cannot answer: look the part up on homedepot.com by web
 * search and write that price onto the line, marked as an estimate.
 *
 * Deliberately narrow. It only runs after every catalog attempt is spent, it only touches lines
 * that are still unpriced and untouched by a technician, and what it writes stays flagged
 * (`priceEstimated`) so the DTO can show it differently, completion can block on it, and the
 * next turn's sweep can replace it with a real catalog price. No pricebook row is created: these
 * prices must never become the company's remembered price for a part, and must never be matched
 * against by a later line.
 */
async function webSearchFallback(
  searchTerm: string,
  companyId: number,
  lineItemIds?: string[]
): Promise<void> {
  if (!lineItemIds || lineItemIds.length === 0) return;

  const targets = await prisma.quoteLineItem.findMany({
    where: {
      id: { in: lineItemIds },
      manuallyEdited: false,
      unitPrice: null,
      quote: { companyId, status: "DRAFT" },
    },
    select: { id: true, quantity: true, unit: true },
  });
  if (targets.length === 0) return;

  const found = await lookupHomeDepotViaWebSearch(searchTerm);
  if (!found) return;

  for (const row of targets) {
    // Same pack rule as a catalog price: the supplier still only sells whole packs, so a count
    // rounds up. A length keeps the technician's own figure — see packMath.
    const packed = packAwareQuantity(
      row.quantity == null ? null : Number(row.quantity),
      found.unit ?? row.unit,
      found.packQuantity
    );
    await prisma.quoteLineItem.update({
      where: { id: row.id },
      data: {
        unitPrice: found.unitPrice,
        unit: found.unit ?? row.unit,
        // The sentinel IS the marker; there is no column to store a link in, so the DTO derives
        // a Home Depot search URL from the line's searchTerm. A reported product URL is dropped
        // rather than kept — most fail the product-page shape test anyway, and a search link
        // always resolves.
        pricebookCode: ESTIMATED_PRICE_CODE,
        ...(packed.rounded ? { quantity: packed.quantity } : {}),
      },
    });
  }

  logger.info("Priced from web search as an estimate", {
    searchTerm,
    lines: targets.length,
    unitPrice: found.unitPrice,
    packQuantity: found.packQuantity,
    linkKind: found.productLink ? "product" : "search",
    title: found.itemName.slice(0, 70),
  });
}

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
      // Retry failed resolves — one item at a time, at most MAX_RESOLVE_ATTEMPTS total tries
      // per term. The ledger persists across turns, so the self-heal sweep in the agent can
      // re-enqueue an unpriced line every turn without an unstocked item burning searches
      // forever.
      const attemptKey = `${companyId}::${searchTerm.trim().toLowerCase()}`;
      let resolved: ResolvedCatalogItem | null = null;
      while (!resolved) {
        const attempt = takeResolveAttempt(attemptKey);
        if (attempt == null) break;
        if (attempt > 1) {
          await sleep(RETRY_BACKOFF_MS * (attempt - 1));
          logger.info("Catalog resolve retry", { searchTerm, attempt });
        }
        try {
          resolved = await resolveFromHomeDepot(searchTerm, companyId);
        } catch (err) {
          logger.warn("Catalog resolve attempt failed", {
            searchTerm,
            attempt,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (!resolved) {
        await webSearchFallback(searchTerm, companyId, lineItemIds);
        return;
      }

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
        // A price only applies to a line whose unit measures the same thing. Backfilling a
        // per-EA spool price onto a line stated in feet would also overwrite the
        // technician's "ft" with "EA" while keeping the footage as the quantity — a $288k
        // line. Incompatible → leave the line unpriced and flagged.
        if (row.unit && !unitsCompatible(row.unit, resolved.unit)) {
          logger.info("Backfill refused: line unit incompatible with priced unit", {
            lineItemId: row.id,
            lineUnit: row.unit,
            pricedUnit: resolved.unit,
          });
          continue;
        }
        const unit = resolved.unit ?? row.unit;
        const packed = packAwareQuantity(
          row.quantity == null ? null : Number(row.quantity),
          unit,
          resolved.packageQuantity,
          resolved.unit
        );
        await prisma.quoteLineItem.update({
          where: { id: row.id },
          data: {
            unitPrice: resolved.unitPrice,
            unit: resolved.unit,
            // A verified catalog price supersedes any web-search estimate: writing the real
            // code over the EST sentinel is what retires it.
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
