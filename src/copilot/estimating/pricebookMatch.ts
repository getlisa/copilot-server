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

export function tokenize(text: string): string[] {
  return text
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

/** Best pricebook match for a free-text description, or null if nothing is close enough. */
export function matchPricebook<T extends MatchablePricebookItem>(
  query: string,
  items: T[]
): T | null {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return null;

  let best: T | null = null;
  let bestScore = 0;

  for (const item of items) {
    const hay = tokenize(
      `${item.description} ${item.synonyms.join(" ")} ${item.code}`
    );
    const haySet = new Set(hay.flatMap(variants));
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
