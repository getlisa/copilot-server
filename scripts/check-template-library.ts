/**
 * Template-library render resolution (Feature B / Phase 1): the blocks a proposal renders
 * with resolve chosen → company default → legacy column → null (built-in), and a deleted or
 * foreign chosen template falls through instead of failing. This is the money path — the
 * chain decides what design appears on the document the customer signs.
 *
 * Run: npx tsx scripts/check-template-library.ts
 */
import { matchTemplateToJobType, pickBlocks } from "../src/lib/proposalTemplates";

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

// ---------------------------------------------------------------- matchTemplateToJobType
// The ZT job-type → template matcher. Predictability is the contract: an admin must be able
// to tell which template a job type lands on from the names alone, and ambiguity must ask
// rather than guess.

const T = (id: number, name: string) => ({ id, name });
const lib = [
  T(1, "NFPA 25 Inspection Proposal"),
  T(2, "Sprinkler Repair Proposal"),
  T(3, "Backflow Install Proposal"),
];

// Clear word overlap picks the one template it points at.
assert(
  matchTemplateToJobType(lib, "Annual NFPA 25 Inspection")?.id === 1,
  "job type sharing nfpa/25/inspection must pick the inspection template"
);

// "Fire Sprinkler Inspection" shares 'inspection' with one template and 'sprinkler' with
// another — genuinely ambiguous, so it matches nothing and the chat asks.
assert(
  matchTemplateToJobType(lib, "Annual Fire Sprinkler Inspection") === null,
  "a job type pointing at two templates equally must match neither"
);

// Containment beats token counting.
assert(
  matchTemplateToJobType([T(1, "Inspection"), T(2, "Fire Inspection Report")], "Fire Inspection")?.id === 2,
  "contained name must win over a token-overlap match"
);

// A tie is ambiguity — no match, the chat asks.
assert(
  matchTemplateToJobType([T(1, "Fire Alarm Proposal"), T(2, "Fire Pump Proposal")], "Fire Watch") === null,
  "a tied score must match nothing"
);

// Noise words alone ("New Proposal") must not match anything.
assert(
  matchTemplateToJobType(lib, "New Proposal") === null,
  "noise-word-only job types must not match"
);

// No overlap at all → null.
assert(matchTemplateToJobType(lib, "AC Installation") === null, "unrelated job type must not match");

// Missing inputs.
assert(matchTemplateToJobType(lib, null) === null, "null job type must not match");
assert(matchTemplateToJobType([], "Inspection") === null, "empty library must not match");

console.log("check-template-library: matcher assertions passed");
