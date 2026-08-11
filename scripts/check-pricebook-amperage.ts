/**
 * Regression check for unit-aware pricebook matching.
 *
 * Guards the bug this was written for: `tokenize` drops bare digits, so "20 amp breaker"
 * reduced to [amp, breaker] and scored 1.0 against EVERY breaker — the first row won the tie
 * and a 20A request matched a 15A breaker. A silently wrong price on the exact attribute the
 * technician specified, which is the one failure mode the never-invent-a-price design exists
 * to prevent. canonicalizeUnits() folds "20 amp"/"20-Amp"/"20 ampere" to "20a" so the number
 * survives tokenization.
 *
 * Pure — no network, no database.
 *   npx tsx scripts/check-pricebook-amperage.ts
 */
import { matchPricebook, tokenize } from "../src/copilot/estimating/pricebookMatch";

const BOOK: [string, string, string, number, string[]][] = [
  ["EL-001", "THHN Copper Wire 12AWG (100ft)", "ROLL", 32, ["wire", "wires", "electrical wire"]],
  ["EL-002", "Toggle Light Switch 15A Single-Pole", "EA", 4.5, ["switch", "switches", "light switch"]],
  ["EL-003", "Electrical Panel 100A 20-space Load Center", "EA", 185, ["panel", "breaker panel", "electrical panel"]],
  ["EL-004", "Electrical Panel 200A 40-space Load Center", "EA", 320, ["panel", "bigger panel", "large panel"]],
  ["EL-006", "Circuit Breaker 15A Single-Pole", "EA", 7.25, ["breaker", "circuit breaker", "15 amp breaker", "15a breaker"]],
  ["EL-007", "Circuit Breaker 20A Single-Pole", "EA", 8.5, ["breaker", "circuit breaker", "20 amp breaker", "20a breaker", "branch breaker"]],
  ["EL-008", "Circuit Breaker 30A Double-Pole", "EA", 14.5, ["breaker", "double pole breaker", "30 amp breaker", "30a breaker"]],
  ["EL-009", "Main Breaker 100A", "EA", 46, ["main breaker", "main breaker 100", "100a main"]],
  ["EL-010", "Main Breaker 200A", "EA", 78, ["main breaker", "main breaker 200", "200a main"]],
  ["EL-011", "GFCI Receptacle 20A Self-Test", "EA", 18.98, ["gfci", "gfci receptacle", "gfci outlet", "ground fault outlet"]],
  ["EL-012", 'EMT Conduit 3/4" (10ft)', "STICK", 10.88, ["emt", "emt conduit", "conduit", "electrical conduit"]],
  ["LB-002", "Labor — Tech II Journeyman (per hour)", "HR", 75, ["labor", "journeyman"]],
];

const items = BOOK.map(([code, description, unit, unitPrice, synonyms], i) => ({
  id: i + 1, code, description, unit, unitPrice, synonyms,
}));

/** null = must NOT match. Prose scope descriptions belong in the null set: no catalog stocks
 *  "panel repair components", and guessing at one would invent a price. */
const CASES: [string, string | null][] = [
  ["20A main breaker", "EL-007"],
  ["20 amp breaker", "EL-007"],
  ["20A breaker", "EL-007"],
  ["circuit breaker 20 amp", "EL-007"],
  ["15 amp breaker", "EL-006"],
  ["30A double pole breaker", "EL-008"],
  ["main breaker 200A", "EL-010"],
  ["gfci receptacle", "EL-011"],
  ["emt conduit", "EL-012"],
  ["12 gauge wire", "EL-001"],
  ["200 amp panel", "EL-004"],
  ["Panel repair/replacement components for indoor flush-mount panel", null],
  ["Branch circuit wiring repair/replacement", null],
  ["Wire connectors/lugs/terminations", null],

  // --- Wrong-spec rejections. Every one of these MATCHED and produced a plausible wrong
  // price before spec tokens became a hard constraint; all four were verified against the
  // real module by independent reviewers. A near-miss must leave the line blank.
  ["60A double pole circuit breaker", null], // matched EL-008 30A at $14.50 for a ~$70 part
  ["100A double pole circuit breaker", null], // matched EL-008 30A
  ["6 AWG THHN wire", null], // matched EL-001 12AWG
  ["4 in square junction box", null], // integer inches were erased; matched a 2 in box at 1.0
  ["2 in square junction box", null], // no 2 in row seeded either — must not fall back
  // ...while correct requests must still resolve, including pole count spoken as a word.
  ["30A double pole circuit breaker", "EL-008"],
  ["20A single pole circuit breaker", "EL-007"],
];

const t = tokenize("20 amp breaker");
if (!t.includes("20a")) {
  console.log(`FAIL  tokenize("20 amp breaker") = [${t}] — expected the amperage to survive as "20a"`);
  process.exit(1);
}
console.log(`tokenize("20 amp breaker") = [${t}]  ✓ amperage preserved\n`);

let pass = 0;
for (const [q, expected] of CASES) {
  const got = matchPricebook(q, items)?.code ?? null;
  const ok = got === expected;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  "${q}"  expected=${expected ?? "null"} got=${got ?? "null"}`);
}
console.log(`\n──── ${pass}/${CASES.length} passed`);
process.exit(pass === CASES.length ? 0 : 1);
