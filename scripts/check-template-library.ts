/**
 * Template-library render resolution (Feature B / Phase 1): the blocks a proposal renders
 * with resolve chosen → company default → legacy column → null (built-in), and a deleted or
 * foreign chosen template falls through instead of failing. This is the money path — the
 * chain decides what design appears on the document the customer signs.
 *
 * Run: npx tsx scripts/check-template-library.ts
 */
import { pickBlocks } from "../src/lib/proposalTemplates";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const chosen = [{ kind: "static", parts: [] }];
const companyDefault = [{ kind: "dynamic", type: "logo" }];
const legacy = [{ kind: "dynamic", type: "lineItems" }];

// The quote's chosen template wins over everything.
assert(
  pickBlocks({ chosen, companyDefault, legacy }) === chosen,
  "chosen template must win over default and legacy"
);

// Chosen template gone (deleted, or a foreign company's id) → company default.
assert(
  pickBlocks({ chosen: null, companyDefault, legacy }) === companyDefault,
  "missing chosen template must fall through to the company default"
);

// No default row yet → the legacy companies.proposal_template column (read-fallback
// until the column is dropped).
assert(
  pickBlocks({ chosen: null, companyDefault: null, legacy }) === legacy,
  "no default template must fall through to the legacy column"
);

// Nothing anywhere → null, which every renderer treats as DEFAULT_PROPOSAL_BLOCKS.
assert(
  pickBlocks({ chosen: null, companyDefault: null, legacy: null }) === null,
  "no template anywhere must resolve to null (built-in default)"
);

console.log("check-template-library: all assertions passed");
