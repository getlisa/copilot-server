/**
 * Fuzzy pricebook matching for the Estimating Agent.
 *
 * Deliberately dumb token-overlap scoring over description + synonyms + code.
 * The pricebook is per-org and small (hundreds of rows), so an in-memory scan
 * is fine. Never guesses: below-threshold queries return null → the line item
 * is flagged unmatched/unpriced instead of getting an invented price.
 */

/**
 * Collapse duplicate codes when a company's matchable rows include other companies'
 * HOME_DEPOT cache rows. The company's own row always wins (its book is authoritative
 * for itself); between foreign copies of the same code, the freshest resolve wins
 * (retail prices drift, and every HD row of a code names the same product).
 */
export function dedupeSharedRows<
  T extends { code: string; companyId: number; lastResolvedAt?: Date | null }
>(rows: T[], companyId: number): T[] {
  const byCode = new Map<string, T>();
  for (const row of rows) {
    const kept = byCode.get(row.code);
    if (!kept || rowWins(row, kept, companyId)) byCode.set(row.code, row);
  }
  return [...byCode.values()];
}

function rowWins(
  a: { companyId: number; lastResolvedAt?: Date | null },
  b: { companyId: number; lastResolvedAt?: Date | null },
  companyId: number
): boolean {
  const aOwn = a.companyId === companyId;
  if (aOwn !== (b.companyId === companyId)) return aOwn;
  return (a.lastResolvedAt?.getTime() ?? 0) > (b.lastResolvedAt?.getTime() ?? 0);
}

export interface MatchablePricebookItem {
  id: number;
  code: string;
  description: string;
  unit: string;
  unitPrice: number;
  synonyms: string[];
}

const STOPWORDS = new Set([
  "a", "an", "the", "of", "for", "to", "and", "or", "some", "more",
  "new", "need", "needs", "i", "we", "my", "with", "that", "this",
  // quantity words — quantities are parsed separately, they only dilute matching
  "couple", "few", "several", "pair", "bunch",
  // unit words, same reason
  "ft", "foot", "feet", "inch", "inches", "ea", "each",
  "pack", "roll", "box", "stick", "lb", "lbs", "gal",
]);

/**
 * Collapse a spelled-out measurement onto the compact form the catalog uses, so the NUMBER
 * survives tokenization: "20 amp" / "20-Amp" / "20 ampere" → "20a", "12 gauge" → "12awg".
 *
 * Without this, bare digits are dropped by the `/^\d+$/` filter below and "20 amp breaker"
 * reduces to [amp, breaker] — which scores 1.0 against EVERY breaker regardless of rating.
 * Measured consequence: "20 amp breaker" matched a 15A breaker (first row wins a tie), i.e.
 * a silently wrong price on the exact attribute the technician specified.
 */
const UNIT_CANON: Record<string, string> = {
  a: "a", amp: "a", amps: "a", ampere: "a", amperes: "a",
  awg: "awg", ga: "awg", gauge: "awg",
  v: "v", volt: "v", volts: "v",
  w: "w", watt: "w", watts: "w",
  p: "p", pole: "p", poles: "p",
  hp: "hp", horsepower: "hp",
};

function canonicalizeUnits(text: string): string {
  return (
    text
      // Fire-protection vocabulary: "waterflow switch" and "flow switch" are the same device.
      // Measured consequence (2026-08-24): the model's searchTerm said "waterflow", the
      // company's base row said "FLOW SWITCH", its corrosion-resistant rows said "WATERFLOW" —
      // exact-word scoring priced a \$1,115.86 CR variant over the \$474.93 row the technician
      // named verbatim. Both sides normalize, so the spelling can never decide the match.
      .replace(/\bwater\s*flow\b/gi, "flow")
      // Aught gauge sizes FIRST: "4/0 AWG" must reduce to the bare "4/0" Home Depot titles
      // use. Left to the number-unit rule below, the "0 AWG" tail alone matched and produced
      // the token "4/0awg", which no retail title contains — every aught-size conductor
      // (1/0-4/0, i.e. all service-entrance wire) failed the spec-token gate unmatchable.
      .replace(/\b([1-4])\s*\/\s*0\s*-?\s*(?:awg|gauge|ga)\b/gi, "$1/0")
      // Pole count spoken as a word: "double pole" must match "2-Pole" and vice versa, or a
      // 2-pole request scores against a single-pole row on the remaining tokens alone.
      .replace(/\b(single|double|triple)\s*-?\s*(?:pole|poles|p)\b/gi, (_m, w: string) =>
        `${({ single: 1, double: 2, triple: 3 } as Record<string, number>)[w.toLowerCase()]}p`
      )
      // Temperature rating: the catalog writes "155°F", the model writes "155F", "155 F" or
      // "155 degrees F". The degree sign splits the number off the F on the CATALOG side only,
      // so the query's "200f" became a spec token (it carries a digit) that no row could ever
      // satisfy — every temperature-qualified sprinkler head came back unmatched and unpriced
      // on a customer-facing quote. Both sides normalize, so the spelling cannot decide it.
      // Known gap: a dual-rating row ("135/165°F") reduces to one "135/165f" token, which a
      // single-temperature query still misses.
      .replace(/(\d+(?:\.\d+)?)\s*(?:°|\s*-?\s*deg(?:ree)?s?\.?)?\s*-?\s*([fc])\b/gi, "$1$2")
      // Inch marks and words, INCLUDING the bare "in" the prompt teaches the model to emit.
      // Without the last form, "4 in square junction box" lost its 4 to the bare-digit filter
      // below and matched a 2 in box at score 1.0 — full confidence, wrong size.
      .replace(/(\d(?:[\d./]*\d)?)\s*(?:"|''|”)/g, "$1in")
      .replace(/(\d(?:[\d./]*\d)?)\s*-?\s*(?:inches|inch|in)\b/gi, "$1in")
      .replace(
        /(\d+(?:\.\d+)?)\s*-?\s*(horsepower|hp|amperes|ampere|amps|amp|awg|gauge|ga|volts|volt|poles|pole|watts|watt|a|v|w|p)\b/gi,
        (_m, n: string, unit: string) => `${n}${UNIT_CANON[unit.toLowerCase()] ?? unit.toLowerCase()}`
      )
  );
}

/**
 * Tokens that carry a measurement — amperage, gauge, size, pole count. These are HARD
 * constraints, not score contributors.
 *
 * Scoring alone cannot protect them: `score = hits / queryTokens`, so a single missed token
 * out of four still scores 0.75 and clears MATCH_THRESHOLD. Verified consequences before this
 * guard: "60A double pole circuit breaker" matched a 30A row ($14.50 for a ~$70 part),
 * "6 AWG THHN wire" matched 12AWG, "3/4 in EMT conduit" matched 1/2 in. Each is a plausible
 * price on a customer-facing quote, which is the exact failure this system exists to prevent.
 */
function specTokens(tokens: string[]): string[] {
  return tokens.filter((t) => /\d/.test(t));
}

/**
 * The product noun: the last token carrying no measurement. In the noun phrases technicians
 * and searchTerms use — "1/2 in EMT conduit", "20A single pole circuit breaker", "12 gauge
 * wire" — this is the head noun, the thing actually being bought. Everything before it
 * qualifies it.
 *
 * It is a HARD constraint for the same reason measurements are, and it catches what they
 * cannot: matching parts of one system share every spec and differ only here. Verified on
 * production quote e3657733 (2026-08-11), where one cached row — a $0.85 1/2 in EMT
 * set-screw connector — was also serving the "1/2 in EMT conduit" and "1/2 in EMT strap"
 * lines. Both scored 2 of 3 tokens (the size and "EMT" both hit) and cleared the 0.6
 * threshold, so each line showed the connector's price AND its Home Depot product link, on
 * a customer-facing quote, for a ~$12 stick of conduit.
 *
 * The rule only ever rejects: a line the catalog can't confirm stays blank for the
 * technician, which is the whole premise of never inventing a price.
 */
/**
 * Trailing words that GROUP products rather than name one — "strut channel support system",
 * "junction box kit". No retail title calls itself a "system", so taking one as the head noun
 * makes the gate unsatisfiable by every row; the word before it is the real product. Falls
 * back to the last token when everything is generic, preserving the old behavior for pure
 * scope text ("feeder makeup"), which must stay unmatchable.
 */
const GENERIC_NOUNS = new Set([
  "system", "kit", "assembly", "package", "hardware", "materials", "material",
  "components", "component", "supplies",
]);

function productNoun(tokens: string[]): string | null {
  let fallback: string | null = null;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (/\d/.test(tokens[i])) continue;
    fallback ??= tokens[i];
    if (!GENERIC_NOUNS.has(tokens[i])) return tokens[i];
  }
  return fallback;
}

export function tokenize(text: string): string[] {
  return (
    canonicalizeUnits(text)
      .toLowerCase()
      .replace(/[^a-z0-9./"-]+/g, " ")
      // "-", "/" and "." survive only BETWEEN digits, where they are part of a size ("4/0",
      // "1-1/4in", "2.5", "12-2"). Anywhere else they are word joiners or punctuation and
      // must split/strip: retail "1-1/4 in." otherwise tokenized as "1-1/4in." and failed the
      // spec constraint against the query's "1-1/4in", and compounds like "3-Phase" and
      // "breaker/disconnect" made the product-noun constraint unsatisfiable by any row.
      .replace(/(?<![0-9])[-/.]|[-/.](?![0-9])/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
  );
}

/** Singular/plural variants so "switches" matches "switch" without a stemmer. */
function variants(t: string): string[] {
  const v = [t];
  if (t.length > 3 && t.endsWith("s")) v.push(t.slice(0, -1));
  if (t.length > 4 && t.endsWith("es")) v.push(t.slice(0, -2));
  return v;
}

/**
 * Mutually exclusive product orientations. Like a measurement, one of these NAMES THE PART:
 * a sidewall head and an upright head share every other word in the row, so scoring alone
 * priced a 200°F UPRIGHT head for a 200°F SIDEWALL request once the temperature matched.
 * Required, never scored — a row that does not carry the orientation the technician asked
 * for is a different part, and a blank line beats a plausible wrong price.
 */
const VARIANT_WORDS = new Set(["upright", "pendant", "sidewall", "concealed"]);

const MATCH_THRESHOLD = 0.6;

/**
 * Head nouns that name an ACCESSORY to a device rather than the device itself. A row whose
 * own head noun is one of these must not price a query that never asked for it: "Ground Rod
 * Clamp" contains "rod", so the query "ground rod" sails through the product-noun gate and
 * a $4.35 clamp prices a $21 rod — measured on a real quote. The reverse is safe (a query
 * naming the accessory still matches it), so this only ever rejects.
 */
const ACCESSORY_NOUNS = new Set([
  "clamp", "connector", "strap", "cover", "bracket", "cap", "bushing", "coupling", "plate",
]);

/**
 * Negation: "FLOW SWITCH NO RETARD" contains the token "retard", so token overlap scored it a
 * perfect hit for the query "flow switch with retard" — the technician asked for a retard and
 * was priced the one product explicitly WITHOUT one (\$426.86, real quote 2026-08-24). A word
 * preceded by no/without/w/o is the OPPOSITE of a hit: it is collected here and enforced as a
 * hard gate in both directions ("without retard" must not match a "W/ RETARD" row either).
 * "no-hub coupling"-style product names survive because both sides negate the same word.
 */
const NEGATION_RE = /\b(?:no|without|w\/o)[\s-]+([a-z0-9]+)/g;

function negatedTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of canonicalizeUnits(text).toLowerCase().matchAll(NEGATION_RE)) out.add(m[1]);
  return out;
}

/** Remove negation phrases so the negated word neither scores nor becomes the head noun. */
function stripNegations(text: string): string {
  return canonicalizeUnits(text).toLowerCase().replace(NEGATION_RE, " ");
}

/** Best pricebook match for a free-text description, or null if nothing is close enough. */
export function matchPricebook<T extends MatchablePricebookItem>(
  query: string,
  items: T[]
): T | null {
  // EXACT PASS FIRST: a query that IS a row's code ("VSRF0100", "09804FC/B") is a direct
  // lookup, not a fuzzy question — tokenization mangles part numbers with separators, and no
  // gate or score should second-guess a technician quoting the catalog's own identifier.
  const exact = query.trim().toUpperCase();
  if (exact) {
    const byCode = items.filter((i) => i.code.toUpperCase() === exact);
    if (byCode.length === 1) return byCode[0];
  }

  const qNegated = negatedTokens(query);
  const qTokens = tokenize(stripNegations(query));
  if (qTokens.length === 0) return null;
  const required = [...specTokens(qTokens), ...qTokens.filter((t) => VARIANT_WORDS.has(t))];
  const noun = productNoun(qTokens);

  let best: T | null = null;
  let bestScore = 0;
  let bestHaySize = Infinity;
  let bestExtraVariants = Infinity;

  for (const item of items) {
    const hayNegated = negatedTokens(item.description);
    const hay = tokenize(
      `${stripNegations(item.description)} ${item.synonyms.join(" ")} ${item.code}`
    );
    const haySet = new Set(hay.flatMap(variants));

    // HARD CONSTRAINT: a word one side negates and the other side asks for positively makes
    // the products opposites — "with retard" vs "NO RETARD" — however well the rest scores.
    if ([...hayNegated].some((t) => !qNegated.has(t) && qTokens.some((q) => variants(q).includes(t)))) continue;
    if ([...qNegated].some((t) => !hayNegated.has(t) && haySet.has(t))) continue;

    // HARD CONSTRAINT: every measurement and orientation word in the query must be present.
    // A row missing one is a different product, however well the remaining words score.
    // Rejecting it leaves the line blank for the technician, which is always preferable to a
    // near-miss price.
    if (!required.every((t) => haySet.has(t))) continue;
    // HARD CONSTRAINT: the row must name the same kind of thing. Fittings, straps, conduit
    // and connectors of one size are otherwise indistinguishable by score.
    if (noun && !variants(noun).some((v) => haySet.has(v))) continue;
    // HARD CONSTRAINT, reversed: a row whose OWN head noun is an accessory word must not
    // price a query that never asked for that accessory — see ACCESSORY_NOUNS.
    const hayNoun = productNoun(tokenize(stripNegations(item.description)));
    if (
      hayNoun &&
      ACCESSORY_NOUNS.has(hayNoun) &&
      !qTokens.some((t) => variants(t).includes(hayNoun) || variants(hayNoun).includes(t))
    )
      continue;
    let hit = 0;
    for (const t of qTokens) {
      if (variants(t).some((v) => haySet.has(v))) hit += 1;
      else if (
        hay.some(
          (h) =>
            h.length > 3 && t.length > 3 && (h.includes(t) || t.includes(h))
        )
      )
        hit += 0.75;
    }
    const score = hit / qTokens.length;
    // Tie-break: the row with the FEWEST tokens wins an equal score. Every query word matched
    // both rows, so the shorter description carries less specificity the technician never
    // asked for — "FLOW SWITCH RETARD & GLUE" must beat '2-1/2" CORROSION RESISTANT WATERFLOW
    // ALARM SWITCH W/ RETARD' for the query "flow switch with retard". Before this, a tie
    // went to whichever row happened to scan first (DB order), which priced that CR variant.
    const descSize = tokenize(item.description).length;
    // Tie-break, first key: the row carrying FEWER orientations the query never named. Raw
    // token count is an accidental proxy for "plainest" — a dual-rating row like
    // "155/165°F CONCEALED" is one token shorter than a plain "155°F PENDANT" row, so a bare
    // "sprinkler head" query silently moved from a \$5.25 pendant to a \$14.50 concealed head.
    const extraVariants = new Set(
      hay.filter((t) => VARIANT_WORDS.has(t) && !qTokens.includes(t))
    ).size;
    if (
      score > bestScore ||
      (score === bestScore &&
        best &&
        (extraVariants < bestExtraVariants ||
          (extraVariants === bestExtraVariants && descSize < bestHaySize)))
    ) {
      bestScore = score;
      bestHaySize = descSize;
      bestExtraVariants = extraVariants;
      best = item;
    }
  }

  return bestScore >= MATCH_THRESHOLD ? best : null;
}

/**
 * LOOSE search: every row of the client's book whose words overlap the utterance, best first.
 *
 * `matchPricebook()` answers "which row IS this part" and is deliberately strict — one row or
 * nothing. This answers the different question "what does this client actually stock around
 * here", so the agent can build its clarifying questions out of the catalog's OWN variants.
 * Without it the model invents plausible specs the book cannot price: a technician answering
 * "sidewall / 200°F / chrome" got a line with no price, because that book stocks sidewall
 * heads at 155°F only (bug report 2026-09-25).
 *
 * No hard gates here on purpose — a candidate list is for reading, not for pricing, and an
 * over-tight list would hide exactly the near-variants the question needs to offer.
 */
export function searchPricebookCandidates<T extends MatchablePricebookItem>(
  query: string,
  items: T[],
  limit = 12
): T[] {
  const qTokens = tokenize(stripNegations(query));
  if (qTokens.length === 0) return [];
  // Two shared words keeps "sprinkler head" out of every row that merely says "head"; a
  // one-word utterance can only ever clear one.
  const minHits = Math.min(2, qTokens.length);

  const scored: { item: T; hits: number }[] = [];
  for (const item of items) {
    const haySet = new Set(
      tokenize(
        `${stripNegations(item.description)} ${item.synonyms.join(" ")} ${item.code}`
      ).flatMap(variants)
    );
    let hits = 0;
    for (const t of qTokens) if (variants(t).some((v) => haySet.has(v))) hits += 1;
    if (hits >= minHits) scored.push({ item, hits });
  }
  return scored
    .sort((a, b) => b.hits - a.hits || a.item.description.length - b.item.description.length)
    .slice(0, limit)
    .map((s) => s.item);
}
