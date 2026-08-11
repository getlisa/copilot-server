/**
 * Regression check for reading pack size off a Home Depot title.
 *
 * This is the arithmetic that decides a stored unit price whenever `home_depot_product` is
 * unreachable — its normal state as of 2026-08-12, measured as a 45s zero-byte hang on a
 * direct request with a fresh key. Getting it wrong means a pack price quoted as a unit price,
 * which is the one thing the pricing path must never do, so every case here is a real title.
 *
 * Titles and prices below came from a live `home_depot` search for "1/2 in EMT coupling"
 * (2026-08-12). The first case is the proof: the product endpoint had already priced that
 * item at $0.59/EA, and 2.95 / 5 reproduces it exactly.
 *
 * Pure — no network, no database.
 *   npx tsx scripts/check-pack-parsing.ts
 */
import { packQuantityFromTitle } from "../src/lib/serpapi";

/** [title, expected pack quantity | null = refuse to divide] */
const CASES: [string, number | null][] = [
  // Real search results, verbatim.
  ["1/2 in. Standard Fitting Electric Metallic Tube (EMT) Set-Screw Coupling (5-Pack)", 5],
  ["1/2 in. Electrical Metallic Tubing (EMT) Set-Screw Coupling (50-Pack)", 50],
  ["1/2 in. Electrical Metallic Tube (EMT) Rain Tight Coupling (5-Pack)", 5],
  // No bulk wording at all → one item, priced as listed.
  ["1/2 in. Electrical Metallic Tube (EMT) Set-Screw Connector", 1],
  ["Smart Box 1-Gang Adjustable Depth Device Box", 1],
  ["15 Amp 120/277 Volt Single Pole Antimicrobial Treated Decorator Switch", 1],
  // Other spellings Home Depot uses.
  ["Wire Connector Assortment (100-Count)", 100],
  ["3/4 in. EMT One-Hole Strap 10 Pack", 10],
  ["Yellow Wire Connectors, Pack of 25", 25],
  ["Steel Junction Box (2-Piece)", 2],
  ["Grounding Screws 12-Pack", 12],
  // Bulk advertised with no number — dividing would be a guess, so refuse and leave the line
  // blank. This is the case that keeps a pack price off a customer quote.
  ["Assorted Wire Connectors Bulk Pack", null],
  ["Contractor Case of EMT Couplings", null],
  // A "kit" is itself the thing being bought — not a multipack.
  ["Ground Bar Kit for Load Center", 1],
];

let pass = 0;
for (const [title, expected] of CASES) {
  const got = packQuantityFromTitle(title);
  const ok = got === expected;
  if (ok) pass++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  pack=${String(got).padEnd(4)} expected=${String(expected).padEnd(4)} ${title}`
  );
}

// The end-to-end claim: the fallback reproduces the price the product endpoint had stored.
const derived = Math.round((2.95 / (packQuantityFromTitle(CASES[0][0]) ?? 1)) * 100) / 100;
const priceOk = derived === 0.59;
if (priceOk) pass++;
console.log(
  `${priceOk ? "PASS" : "FAIL"}  $2.95 / 5-Pack = $${derived} — HD-100144234 was stored at $0.59/EA`
);

console.log(`\n──── ${pass}/${CASES.length + 1} passed`);
process.exit(pass === CASES.length + 1 ? 0 : 1);
