import assert from "assert";
import { qboEstimateLines, autoItemName } from "../src/lib/qbo";
import type { LineItemDto } from "../src/copilot/estimating/quoteDto";

/**
 * Pins the quote → QBO Estimate line mapping (QBO PRD US3/US5): base lines carry the
 * marked-up prices, the CHOSEN option's lines post as priced lines, non-chosen options are
 * text notes only, unpriced lines post at $0 marked pending, and item refs come from the
 * per-line resolver (stored pick or auto name).
 */

const line = (over: Partial<LineItemDto>): LineItemDto => ({
  id: "x",
  description: "12 AWG THHN wire",
  quantity: 3,
  unit: "EA",
  unitPrice: 12.1,
  totalPrice: 36.3,
  pricebookCode: null,
  isLabor: false,
  product: null,
  priceEstimated: false,
  estimateLink: null,
  priceSource: null,
  flags: [],
  ambiguousAction: null,
  optionGroup: null,
  searchTerm: null,
  qboItemId: null,
  qboItemName: null,
  sortOrder: 0,
  ...over,
});

const dto = {
  lineItems: [
    line({ id: "a" }),
    line({ id: "b", description: "breaker", unitPrice: null, totalPrice: null, quantity: null }),
    line({ id: "c", description: "replace panel", optionGroup: "Option B", totalPrice: 3930 }),
    line({ id: "d", description: "repair panel", optionGroup: "Option A", totalPrice: 2930 }),
  ],
  optionTotals: [
    { name: "Option A", total: 2930, combinedTotal: 2966.3 },
    { name: "Option B", total: 3930, combinedTotal: 3966.3 },
  ],
};

// Per-line item refs (US5): the resolver hands each line its own QBO item id.
const itemRefFor = (l: LineItemDto) => (l.id === "a" ? "42" : "77");

const lines = qboEstimateLines(dto, "Option B", itemRefFor);

// Priced base line: its own item ref, qty, unit price, marked-up amount.
assert.deepStrictEqual(lines[0], {
  DetailType: "SalesItemLineDetail",
  Amount: 36.3,
  Description: "12 AWG THHN wire",
  SalesItemLineDetail: { ItemRef: { value: "42" }, Qty: 3, UnitPrice: 12.1 },
});

// Unpriced line posts at $0 and says so — it must not block the estimate.
const pending = lines[1];
if (pending.DetailType !== "SalesItemLineDetail") throw new Error("expected a priced line");
assert.strictEqual(pending.Amount, 0);
assert.match(pending.Description, /price pending/);
assert.ok(!("Qty" in pending.SalesItemLineDetail));

// The CHOSEN option's line is a real priced line (US3: the job as sold).
const chosen = lines[2];
if (chosen.DetailType !== "SalesItemLineDetail") throw new Error("expected the chosen option priced");
assert.strictEqual(chosen.Amount, 3930);
assert.strictEqual(chosen.Description, "replace panel");

// The option NOT taken is a text note only — never a priced line.
assert.strictEqual(lines.length, 4);
const alt = lines[3];
if (alt.DetailType !== "DescriptionOnly") throw new Error("expected a description-only line");
assert.match(alt.Description, /not selected — Option A: \$2930\.00/);

// The estimate's implied total is base + chosen option — never the sum of alternatives.
const total = lines.reduce((s, l) => s + ("Amount" in l ? l.Amount : 0), 0);
assert.strictEqual(total, 36.3 + 3930);

// Auto item naming (US5): labor → "Labor"; materials prefer the catalog-shaped searchTerm.
assert.strictEqual(autoItemName(line({ isLabor: true })), "Labor");
assert.strictEqual(
  autoItemName(line({ searchTerm: "12 AWG THHN wire 500ft", description: "prose" })),
  "12 AWG THHN wire 500ft"
);
assert.strictEqual(autoItemName(line({ searchTerm: null })), "12 AWG THHN wire");

console.log("check-qbo: OK");
