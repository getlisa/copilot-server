/**
 * Fuzzy pricebook matching for the Estimating Agent.
 *
 * Deliberately dumb token-overlap scoring over description + synonyms + code.
 * The pricebook is per-org and small (hundreds of rows), so an in-memory scan
 * is fine. Never guesses: below-threshold queries return null → the line item
 * is flagged unmatched/unpriced instead of getting an invented price.
 */

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
};

function canonicalizeUnits(text: string): string {
  return (
    text
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
      // Inch marks and words, INCLUDING the bare "in" the prompt teaches the model to emit.
      // Without the last form, "4 in square junction box" lost its 4 to the bare-digit filter
      // below and matched a 2 in box at score 1.0 — full confidence, wrong size.
      .replace(/(\d(?:[\d./]*\d)?)\s*(?:"|''|”)/g, "$1in")
      .replace(/(\d(?:[\d./]*\d)?)\s*-?\s*(?:inches|inch|in)\b/gi, "$1in")
      .replace(
        /(\d+(?:\.\d+)?)\s*-?\s*(amperes|ampere|amps|amp|awg|gauge|ga|volts|volt|poles|pole|watts|watt|a|v|w|p)\b/gi,
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
function productNoun(tokens: string[]): string | null {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!/\d/.test(tokens[i])) return tokens[i];
  }
  return null;
}

export function tokenize(text: string): string[] {
  return canonicalizeUnits(text)
    .toLowerCase()
    .replace(/[^a-z0-9./"-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** Singular/plural variants so "switches" matches "switch" without a stemmer. */
function variants(t: string): string[] {
  const v = [t];
  if (t.length > 3 && t.endsWith("s")) v.push(t.slice(0, -1));
  if (t.length > 4 && t.endsWith("es")) v.push(t.slice(0, -2));
  return v;
}

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

/** Best pricebook match for a free-text description, or null if nothing is close enough. */
export function matchPricebook<T extends MatchablePricebookItem>(
  query: string,
  items: T[]
): T | null {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return null;
  const required = specTokens(qTokens);
  const noun = productNoun(qTokens);

  let best: T | null = null;
  let bestScore = 0;

  for (const item of items) {
    const hay = tokenize(
      `${item.description} ${item.synonyms.join(" ")} ${item.code}`
    );
    const haySet = new Set(hay.flatMap(variants));

    // HARD CONSTRAINT: every measurement in the query must be present. A row missing one is
    // a different product, however well the remaining words score. Rejecting it leaves the
    // line blank for the technician, which is always preferable to a near-miss price.
    if (!required.every((t) => haySet.has(t))) continue;
    // HARD CONSTRAINT: the row must name the same kind of thing. Fittings, straps, conduit
    // and connectors of one size are otherwise indistinguishable by score.
    if (noun && !variants(noun).some((v) => haySet.has(v))) continue;
    // HARD CONSTRAINT, reversed: a row whose OWN head noun is an accessory word must not
    // price a query that never asked for that accessory — see ACCESSORY_NOUNS.
    const hayNoun = productNoun(tokenize(item.description));
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
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return bestScore >= MATCH_THRESHOLD ? best : null;
}
