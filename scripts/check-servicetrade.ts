import assert from "assert";
import { addrText, jobBits, mapServicetradeLibItem, taxGroupPercent, deficiencyLine } from "../src/lib/servicetradeIngest";
import { servicetradeQuotePayload, quoteJobType } from "../src/lib/servicetradeEstimate";
import type { LineItemDto } from "../src/copilot/estimating/quoteDto";

/**
 * Pins the ServiceTrade payload handling: job → picker/seed bits, lib item → pricebook row,
 * tax group → percent, quote → ServiceTrade quote + items. Pure: no network, no database.
 * Shapes follow api.servicetrade.com/api/legacy-docs (job, libitem, taxgroup, quoteitem).
 *
 *   npx tsx scripts/check-servicetrade.ts
 */

// ---- job bits ----
const job = {
  id: 13,
  name: "Repair Job #112233",
  customName: null,
  type: "repair",
  status: "scheduled",
  number: 112233,
  description: "Repair the hood in the front.",
  vendor: { id: 31, name: "Fire Shield Services" },
  customer: { id: 39, name: "Big Bang Burger Bar" },
  location: {
    id: 33,
    name: "Foo's Bar",
    phoneNumber: "(321) 555-5623",
    address: { street: "123 Typewriter Way", city: "Aiburg", state: "NC", postalCode: "23462" },
    taxable: true,
  },
  serviceRequests: [{ id: 41, description: "Portable Extinguisher Inspection", serviceLineId: 123 }],
  updated: 1399994065,
};
const b = jobBits(job);
assert.strictEqual(b.locationId, "33");
assert.strictEqual(b.customerId, "39");
assert.strictEqual(b.vendorId, "31");
assert.strictEqual(b.serviceLineId, "123");
assert.strictEqual(b.number, "112233");
assert.strictEqual(b.title, "Repair Job #112233");
assert.strictEqual(b.description, "Repair the hood in the front.\nPortable Extinguisher Inspection");
assert.strictEqual(b.locationAddress, "123 Typewriter Way, Aiburg, NC, 23462");
assert.strictEqual(addrText(null), null);

// ---- lib item → pricebook row ----
assert.deepStrictEqual(mapServicetradeLibItem({ id: 104, code: "BCAP-M", name: "Blow-off Cap, Metal", active: true, price: 12.5, cost: 4.25 }), {
  code: "BCAP-M",
  description: "Blow-off Cap, Metal",
  unit: "EA",
  price: 12.5,
});
assert.strictEqual(mapServicetradeLibItem({ id: 105, code: "BCAP-R", name: "Rubber", active: true, price: null, cost: 3.25 })?.price, 3.25); // cost fallback
assert.strictEqual(mapServicetradeLibItem({ id: 567, code: null, name: "Vent Cover", active: true, price: 9 })?.code, "ST-567"); // no code → synthetic
assert.strictEqual(mapServicetradeLibItem({ id: 1, code: "X", name: "Retired", active: false, price: 1 }), null);
assert.strictEqual(mapServicetradeLibItem({ id: 2, code: "Y", name: "Unpriced", active: true, price: null, cost: null }), null);

// ---- tax group → percent ----
assert.strictEqual(taxGroupPercent({ combinedRate: 0.0975 }), 9.75);
assert.strictEqual(taxGroupPercent({ combinedRate: 0.085 }), 8.5);
assert.strictEqual(taxGroupPercent({ combinedRate: 1.5 }), null); // junk
assert.strictEqual(taxGroupPercent({}), null);

// ---- deficiency line ----
assert.deepStrictEqual(deficiencyLine({ description: "Panic door glued shut", proposedFix: "Replace door", severity: "inoperable", asset: { name: "Panic Door" } }), {
  headline: "Panic door glued shut",
  fix: "Replace door",
  severity: "inoperable",
  asset: "Panic Door",
});

// ---- quote → ServiceTrade quote + items ----
const line = (over: Partial<LineItemDto>): LineItemDto => ({
  id: "x",
  description: "Replace door",
  quantity: 2,
  unit: "EA",
  unitPrice: 40,
  totalPrice: 80,
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
const payload = servicetradeQuotePayload(
  { id: "abcdef12-0000", chosenOptionGroup: "Option A", customerName: "Big Bang Burger Bar", taxExempt: false },
  {
    total: 130,
    taxRatePercent: 7.5,
    lineItems: [
      line({ id: "a", pricebookCode: "BCAP-M" }),
      line({ id: "b", description: "Hose reel service", unitPrice: null, totalPrice: null, quantity: 1, taxable: false }),
      line({ id: "c", description: "Premium panel", optionGroup: "Option B", totalPrice: 500 }),
      line({ id: "d", description: "Basic panel", optionGroup: "Option A", unitPrice: 50, totalPrice: 50, quantity: 1 }),
    ],
  },
  { number: "112233", jobType: "inspection" },
  [{ id: "77", text: "Replace door" }],
  (l) => (l.pricebookCode === "BCAP-M" ? "104" : null)
);
assert.strictEqual(payload.quote.name, "Estimate for Big Bang Burger Bar — job #112233");
assert.strictEqual(payload.quote.jobType, "inspection");
assert.deepStrictEqual(payload.deficiencyIds, ["77"]); // matched by wording
// Option B (not chosen) is dropped; chosen Option A's line posts; 3 items total.
assert.deepStrictEqual(
  payload.items.map((i) => [i.description, i.quantity, i.price, i.taxRate, i.libItemId]),
  [
    ["Replace door", 2, 40, 7.5, "104"],
    ["Hose reel service — price pending", 1, 0, 0, null], // non-taxable line → 0
    ["Basic panel", 1, 50, 7.5, null],
  ]
);
assert.ok(payload.quote.notes.includes("Total (ex tax): 130.00"));
// Tax-exempt quote → every item 0; no snapshot rate → null (ServiceTrade applies the location's group).
assert.strictEqual(servicetradeQuotePayload({ id: "q", chosenOptionGroup: null, customerName: null, taxExempt: true }, { total: 80, taxRatePercent: 7.5, lineItems: [line({})] }, { number: null, jobType: null }, []).items[0].taxRate, 0);
assert.strictEqual(servicetradeQuotePayload({ id: "q", chosenOptionGroup: null, customerName: null }, { total: 80, taxRatePercent: null, lineItems: [line({})] }, { number: null, jobType: null }, []).items[0].taxRate, null);
assert.strictEqual(quoteJobType("planned_maintenance"), "repair"); // not a quote job type
assert.strictEqual(quoteJobType(null), "repair");

console.log("ok   check-servicetrade: job bits, lib item map, tax percent, quote payload");
