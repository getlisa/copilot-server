/**
 * Self-check for the fuzzy pricebook matcher (no DB needed):
 *   npx tsx scripts/check-pricebook-match.ts
 */
import assert from "assert";
import { dedupeSharedRows, matchPricebook } from "../src/copilot/estimating/pricebookMatch";

const items = [
  { id: 1, code: "EL-005", description: "Wago 221 Lever Nut Connector (pack of 10)", unit: "PACK", unitPrice: 8.5, synonyms: ["wago", "wago connector"] },
  { id: 2, code: "EL-002", description: "Toggle Light Switch 15A Single-Pole", unit: "EA", unitPrice: 4.5, synonyms: ["switch", "switches"] },
  { id: 3, code: "SP-010", description: 'Tyco 1/2" Pendant Sprinkler Head 155F', unit: "EA", unitPrice: 5.25, synonyms: ["sprinkler head"] },
  { id: 4, code: "PP-030", description: 'CPVC BlazeMaster Pipe 3/4" (10ft)', unit: "STICK", unitPrice: 9.2, synonyms: ["tubing"] },
];

assert.strictEqual(matchPricebook("a Wago connector", items)?.code, "EL-005", "slang/brand match");
assert.strictEqual(matchPricebook("a couple of switches", items)?.code, "EL-002", "plural match");
assert.strictEqual(matchPricebook("5 ft of tubing", items)?.code, "PP-030", "synonym match");
assert.strictEqual(matchPricebook("sprinkler head", items)?.code, "SP-010", "direct match");
assert.strictEqual(matchPricebook("hyperbolic flux capacitor", items), null, "no match → null, never guessed");

// Vocabulary + tie-break (bug report 2026-08-24, quote priced \$1,115.86 for a \$474.93 item):
// "waterflow" and "flow" must be the same word, and at an equal score the PLAINEST row wins —
// a size-and-coating variant the technician never asked for must not beat the base row.
const sprinkler = [
  { id: 80, code: "VSRCR-0250", description: '2-1/2" CORROSION RESISTANT WATERFLOW ALARM SWITCH W/ RETARD', unit: "EA", unitPrice: 1115.86, synonyms: [], companyId: 1 },
  { id: 81, code: "VSR-SFG", description: "FLOW SWITCH RETARD & GLUE", unit: "EA", unitPrice: 474.93, synonyms: [], companyId: 1 },
];
assert.strictEqual(matchPricebook("waterflow switch with retard", sprinkler)?.code, "VSR-SFG", "waterflow≡flow, plainest row wins the tie");
assert.strictEqual(matchPricebook("flow switch with retard", sprinkler)?.code, "VSR-SFG", "tie-break never depends on scan order");
assert.strictEqual(
  matchPricebook("2-1/2 in corrosion resistant waterflow switch with retard", sprinkler)?.code,
  "VSRCR-0250",
  "the specific variant still wins when actually requested"
);

// Exact code = direct lookup, before any fuzzy scoring or gate.
const exactRows = [
  { id: 60, code: "09804FC/B", description: "MODEL B REPLACEMENT COVER PLATE, STANDARD, BRUSHED CHROME 165", unit: "EA", unitPrice: 142.76, synonyms: [], companyId: 1 },
  { id: 61, code: "09804FC", description: "MODEL B REPLACEMENT COVER PLATE, STANDARD, POLISHED CHROME 165", unit: "EA", unitPrice: 117.14, synonyms: [], companyId: 1 },
];
assert.strictEqual(matchPricebook("09804FC/B", exactRows)?.id, 60, "separator-heavy code resolves exactly");
assert.strictEqual(matchPricebook("09804fc", exactRows)?.id, 61, "exact code is case-insensitive and never grabs the longer sibling");

// Negation (bug report 2026-08-24, real quote): "FLOW SWITCH NO RETARD" scored a perfect hit
// for "flow switch with retard" — the technician got the opposite product. A negated word is
// a hard rejection in both directions.
const negRows = [
  { id: 70, code: "VSSP", description: "FLOW SWITCH NO RETARD", unit: "EA", unitPrice: 426.86, synonyms: [], companyId: 1 },
  { id: 71, code: "VSR-SFG2", description: "FLOW SWITCH RETARD & GLUE", unit: "EA", unitPrice: 474.93, synonyms: [], companyId: 1 },
];
assert.strictEqual(matchPricebook("flow switch with retard", negRows)?.code, "VSR-SFG2", "'NO RETARD' row rejected for a with-retard query");
assert.strictEqual(matchPricebook("flow switch retard", negRows)?.code, "VSR-SFG2", "bare 'retard' query also skips the negated row");
assert.strictEqual(matchPricebook("flow switch without retard", negRows)?.code, "VSSP", "asking WITHOUT retard rejects the with-retard rows");
// Both sides negating the same word stay compatible ("no-hub" style product names).
const noHub = [{ id: 72, code: "NH-3", description: "3 in NO-HUB COUPLING", unit: "EA", unitPrice: 12.5, synonyms: [], companyId: 1 }];
assert.strictEqual(matchPricebook("3 in no hub coupling", noHub)?.code, "NH-3", "shared negation is not a mismatch");

// The code column is matchable too (bug report 2026-08-24): a technician quoting a part
// number must hit the row even though the description never contains it.
const coded = [
  { id: 90, code: "VSRF0100", description: "FLOW SWITCH RETARD", unit: "EA", unitPrice: 475.02, synonyms: [], companyId: 1 },
  { id: 91, code: "V5097P", description: "ONE STOP SOLVENT CEMENT PINT", unit: "EA", unitPrice: 54.58, synonyms: [], companyId: 1 },
];
assert.strictEqual(matchPricebook("VSRF0100", coded)?.code, "VSRF0100", "bare part number matches via code");
assert.strictEqual(matchPricebook("vsrf0100 flow switch", coded)?.code, "VSRF0100", "part number + words match");
assert.strictEqual(matchPricebook("solvent cement", coded)?.code, "V5097P", "words match via description");

// Cross-company HD cache sharing: own row beats foreign, freshest foreign wins, no dupes.
const shared = dedupeSharedRows(
  [
    { code: "HD-1", companyId: 2, lastResolvedAt: new Date("2026-01-01") },
    { code: "HD-1", companyId: 3, lastResolvedAt: new Date("2026-06-01") },
    { code: "HD-2", companyId: 2, lastResolvedAt: new Date("2026-01-01") },
    { code: "HD-2", companyId: 1, lastResolvedAt: new Date("2025-01-01") },
    { code: "EL-005", companyId: 1 },
  ],
  1
);
const byCode = new Map(shared.map((r) => [r.code, r]));
assert.strictEqual(shared.length, 3, "one row per code");
assert.strictEqual(byCode.get("HD-1")?.companyId, 3, "freshest foreign resolve wins");
assert.strictEqual(byCode.get("HD-2")?.companyId, 1, "own row beats a fresher foreign one");
assert.strictEqual(byCode.get("EL-005")?.companyId, 1, "manual row untouched");

console.log("pricebook matcher: all checks passed");
