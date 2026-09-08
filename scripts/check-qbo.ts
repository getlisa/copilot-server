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
  taxable: true,
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
    { name: "Option A", total: 2930, combinedTotal: 2966.3, taxAmount: 0, combinedTotalWithTax: 2966.3 },
    { name: "Option B", total: 3930, combinedTotal: 3966.3, taxAmount: 0, combinedTotalWithTax: 3966.3 },
  ],
};

// Per-line item refs (US5): the resolver hands each line its own QBO item id.
const itemRefFor = (l: LineItemDto) => (l.id === "a" ? "42" : "77");

const lines = qboEstimateLines(dto, "Option B", itemRefFor);

// Priced base line: its own item ref, qty, unit price, marked-up amount. `NON` because this
// estimate declares no tax — see the taxed block at the bottom for the other half.
assert.deepStrictEqual(lines[0], {
  DetailType: "SalesItemLineDetail",
  Amount: 36.3,
  Description: "12 AWG THHN wire",
  SalesItemLineDetail: {
    ItemRef: { value: "42" },
    Qty: 3,
    UnitPrice: 12.1,
    TaxCodeRef: { value: "NON" },
  },
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

// ---- per-line taxability (T-63) ----
// Two things are pinned here, and the second is the one that bites.
//
// 1. When the estimate is taxed, a taxable line is TAX and a non-taxable one is NON.
// 2. When it is NOT taxed, every line is explicitly NON rather than silently omitted. Omission
//    was the bug: re-completion posts `sparse: true`, under which an absent field means "keep
//    what is there", so an estimate that once carried Tucson 9.1% and was later cleared kept
//    being taxed by QuickBooks while CLARA's document showed no tax at all.
{
  const mixed = {
    lineItems: [
      line({ id: "m1", description: "wire" }),
      line({ id: "m2", description: "permit fee", taxable: false }),
      line({ id: "m3", description: "labor", isLabor: true, taxable: false }),
    ],
    optionTotals: [],
  };
  const refOf = () => "1";

  const taxed = qboEstimateLines(mixed, null, refOf, true);
  const codeOf = (l: (typeof taxed)[number]) =>
    l.DetailType === "SalesItemLineDetail" ? l.SalesItemLineDetail.TaxCodeRef?.value : null;
  assert.deepStrictEqual(taxed.map(codeOf), ["TAX", "NON", "NON"], "taxable lines are TAX");

  const untaxed = qboEstimateLines(mixed, null, refOf, false);
  assert.deepStrictEqual(
    untaxed.map(codeOf),
    ["NON", "NON", "NON"],
    "an untaxed estimate marks every line NON — never omits the field"
  );
  assert.ok(
    untaxed.every((l) => l.DetailType !== "SalesItemLineDetail" || "TaxCodeRef" in l.SalesItemLineDetail),
    "TaxCodeRef is always present, so a sparse update cannot leave stale tax behind"
  );
}

console.log("check-qbo: OK");
