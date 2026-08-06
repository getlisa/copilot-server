/**
 * Self-check for the fuzzy pricebook matcher (no DB needed):
 *   npx tsx scripts/check-pricebook-match.ts
 */
import assert from "assert";
import { matchPricebook } from "../src/copilot/estimating/pricebookMatch";

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

console.log("pricebook matcher: all checks passed");
