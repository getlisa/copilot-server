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

  // Real cached Home Depot rows from production (company 1, quote e3657733, 2026-08-11).
  // Descriptions and prices are verbatim; synonyms are what the resolver stores — the
  // technician-facing description of whichever line resolved the row first.
  ["HD-100137321", "1/2 in. Electrical Metallic Tube (EMT) Set-Screw Connector", "EA", 0.85, ["1/2 in EMT set screw connector"]],
  ["HD-100144234", "1/2 in. Standard Fitting Electric Metallic Tube (EMT) Set Screw Coupling", "EA", 0.59, ["1/2 in EMT coupling"]],

  // HD-style rows with NO synonym echoing the query, so matching must survive the title's own
  // spelling: the trailing dot in "in.", hyphen/slash compounds, and horsepower as a unit.
  ["HD-125EMT", "1-1/4 in. Electrical Metallic Tube (EMT) Set-Screw Coupling", "EA", 3.12, []],
  ["HD-VFD10", "10 HP 480-Volt 3-Phase Variable Frequency Drive", "EA", 890, ["vfd"]],
  ["HD-MCPD", "Motor Circuit Breaker Disconnect 480V", "EA", 152, []],
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

  // --- Wrong-PRODUCT rejections. Parts of one system share every measurement and differ
  // only in the product noun, so spec tokens cannot separate them: each of these matched the
  // $0.85 set-screw connector row at 2 of 3 tokens ("1/2in" + "emt") and put its price and
  // its Home Depot link on the line. Observed on a live customer quote, not hypothesised.
  ["1/2 in EMT conduit", null], // ~$12 per 10 ft stick, shown as $0.85
  ["1/2 in EMT strap", null],
  ["1/2 in EMT elbow", null],
  ["1/2 in EMT one-hole strap", null],
  // ...and the rows must still match the requests they genuinely are.
  ["1/2 in EMT set screw connector", "HD-100137321"],
  ["1/2 in EMT coupling", "HD-100144234"],
  // A plural request must still reach a singular row (and vice versa) through the noun test.
  ["1/2 in EMT couplings", "HD-100144234"],

  // --- Tokenizer punctuation, from the Golden K industrial quote (2026-08-14). Retail "in."
  // tokenized with its trailing dot ("1-1/4in.") and failed the spec constraint against the
  // query's "1-1/4in"; "3 phase"/"3-Phase" and "breaker/disconnect" compounds made the
  // product-noun constraint unsatisfiable; "10 HP" lost its 10 to the bare-digit filter.
  ["1-1/4 in EMT coupling", "HD-125EMT"],
  ["1/2 in EMT coupling", "HD-100144234"], // size still separates the two coupling rows
  ["10 HP VFD, 480V, 3 phase", "HD-VFD10"],
  ["5 HP VFD, 480V, 3 phase", null], // horsepower is now a spec token — near-miss stays blank
  ["motor circuit breaker/disconnect", "HD-MCPD"],
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
