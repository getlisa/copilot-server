import assert from "assert";
import { jaFlatten, jaIncluded, jaResolve, jaRelId, jaDoc, jaRows } from "../src/lib/uptick";
import { addrText, mapUptickProduct } from "../src/lib/uptickIngest";
import { uptickQuotePayload } from "../src/lib/uptickEstimate";
import type { LineItemDto } from "../src/copilot/estimating/quoteDto";

/**
 * Pins the JSON:API handling and the quote → Uptick defect-quote payload. Pure: no network,
 * no database. Shapes follow Uptick's connector manifest (resource objects with attributes +
 * relationships, `included` side-loads).
 *
 *   npx tsx scripts/check-uptick.ts
 */

// ---- JSON:API list with an include ----
const body = {
  data: [
    {
      type: "Task",
      id: 101,
      attributes: { ref: "T00101", name: "Annual inspection", status: "Inspected", updated: "2026-09-01T00:00:00Z" },
      relationships: { property: { data: { type: "Property", id: 7 } }, client: { data: null }, tags: { data: [] } },
    },
  ],
  included: [{ type: "Property", id: 7, attributes: { name: "Riverside Tower", address: { line1: "1 Bank St", suburb: "Richmond", state: "VIC", postcode: "3121" } }, relationships: { client: { data: { type: "Client", id: 3 } } } }],
  links: { next: null },
};
const rows = jaRows(body);
assert.strictEqual(rows.length, 1);
const task = rows[0];
const flat = jaFlatten(task);
assert.strictEqual(flat.id, "101"); // ids normalized to strings
assert.strictEqual(flat.ref, "T00101");
assert.strictEqual(jaRelId(task, "property"), "7");
assert.strictEqual(jaRelId(task, "client"), null); // null data
assert.strictEqual(jaRelId(task, "tags"), null); // to-many is never a single id
const inc = jaIncluded(body);
const property = jaResolve(task, "property", inc);
assert.strictEqual(property?.name, "Riverside Tower");
assert.strictEqual(addrText(property?.address), "1 Bank St, Richmond, VIC, 3121");
assert.strictEqual(addrText("12 Plain St"), "12 Plain St"); // pre-v2.14 string address
assert.strictEqual(jaResolve(task, "client", inc), null);

// ---- write document ----
const doc = jaDoc("DefectQuoteLineItem", { description: "x", quantity: 1 }, { quote: { type: "DefectQuote", id: "9" }, remark: { type: "Remark", id: null } });
assert.deepStrictEqual(doc, {
  data: { type: "DefectQuoteLineItem", attributes: { description: "x", quantity: 1 }, relationships: { quote: { data: { type: "DefectQuote", id: "9" } } } },
});

// ---- quote → defect quote payload ----
const line = (over: Partial<LineItemDto>): LineItemDto => ({
  id: "x",
  description: "Replace extinguisher bracket",
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
const payload = uptickQuotePayload(
  { id: "abcdef12-0000", chosenOptionGroup: "Option A", customerName: "Body Corp" },
  {
    total: 130,
    lineItems: [
      line({ id: "a" }),
      line({ id: "b", description: "Hose reel service", unitPrice: null, totalPrice: null, quantity: 1 }),
      line({ id: "c", description: "Premium panel", optionGroup: "Option B", totalPrice: 500 }),
      line({ id: "d", description: "Basic panel", optionGroup: "Option A", unitPrice: 50, totalPrice: 50, quantity: 1 }),
    ],
  },
  "T00101",
  [{ id: "55", text: "Replace extinguisher bracket" }],
  // Resolver stand-in: the bracket is a catalog line, everything else falls to the generic product.
  (l) => (l.description.startsWith("Replace extinguisher") ? "P1" : "P-MISC")
);
assert.strictEqual(payload.attributes.description, "Estimate for Body Corp — job T00101");
assert.strictEqual(payload.attributes.date, new Date().toISOString().slice(0, 10));
// Option B (not chosen) is dropped; chosen Option A's line posts; 3 lines total, indexed.
assert.deepStrictEqual(
  payload.lines.map((l) => [l.attributes.description, l.attributes.quantity, l.attributes.unit_price, l.attributes.index, l.remarkId, l.productId]),
  [
    ["Replace extinguisher bracket", 2, 40, 0, "55", "P1"], // matched the remark by wording
    ["Hose reel service — price pending", 1, 0, 1, null, "P-MISC"],
    ["Basic panel", 1, 50, 2, null, "P-MISC"],
  ]
);

// ---- product → pricebook item ----
assert.deepStrictEqual(mapUptickProduct({ id: 9, name: "Extinguisher 4.5kg ABE", code: "EXT-45", unit_price: "89.00", unit_description: "each", is_active: true }), {
  code: "EXT-45",
  description: "Extinguisher 4.5kg ABE",
  unit: "each",
  price: 89,
});
assert.strictEqual(mapUptickProduct({ id: 10, name: "Retired", code: "X", unit_price: 1, is_active: false }), null);
assert.strictEqual(mapUptickProduct({ id: 11, name: "No price", code: "Y" }), null);
assert.strictEqual(mapUptickProduct({ id: 12, name: "Labour", current_price: 120 })?.code, "UP-12"); // no code → synthetic
assert.ok(String(payload.attributes.scope_of_works).includes("Total (ex tax): 130.00"));

console.log("ok   check-uptick: JSON:API helpers + defect-quote payload");
