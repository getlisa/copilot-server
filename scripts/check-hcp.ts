import assert from "assert";
import { addrText, jobBits, mapHcpCatalogItem, hcpExternalId } from "../src/lib/hcpIngest";
import { hcpLineItemsPayload } from "../src/lib/hcpEstimate";
import type { LineItemDto } from "../src/copilot/estimating/quoteDto";

/**
 * Pins the Housecall Pro payload handling: job → picker/seed bits, material/service → pricebook
 * row, quote → job line items. Pure: no network, no database. Shapes follow
 * docs.housecallpro.com (Job, Material, PricebookService, BulkLineItemUpdate).
 *
 *   npx tsx scripts/check-hcp.ts
 */

// ---- job bits ----
const job = {
  id: "job_8f3a",
  invoice_number: "1042",
  description: "Replace water softener\nCustomer reports hard water; existing unit 15 years old.",
  customer: { id: "cus_1", first_name: "Alan", last_name: "Smith", company: null, email: "alan@example.com", mobile_number: "307-555-0100", home_number: null, work_number: null },
  address: { id: "adr_1", type: "service", street: "12 Main St", street_line_2: "Unit B", city: "Cody", state: "WY", zip: "82414", country: "US" },
  notes: [{ id: "n1", content: "Gate code 1234" }],
  work_status: "scheduled",
  schedule: { scheduled_start: "2026-10-09T15:00:00Z" },
  job_fields: { job_type: { id: "jt1", name: "Water Treatment Install" }, business_unit: null },
  updated_at: "2026-10-07T10:00:00Z",
};
const b = jobBits(job);
assert.strictEqual(b.customerId, "cus_1");
assert.strictEqual(b.customerName, "Alan Smith");
assert.strictEqual(b.customerPhone, "307-555-0100");
assert.strictEqual(b.addressLine, "12 Main St, Unit B, Cody, WY, 82414");
assert.strictEqual(b.title, "Replace water softener");
assert.strictEqual(b.jobType, "Water Treatment Install");
assert.strictEqual(b.invoiceNumber, "1042");
assert.deepStrictEqual(b.notes, ["Gate code 1234"]);
assert.strictEqual(jobBits({ customer: { id: "c", first_name: "A", company: "Acme LLC" } }).customerName, "Acme LLC"); // company wins
assert.strictEqual(addrText(null), null);

// ---- material / service → pricebook row (cents → dollars) ----
assert.deepStrictEqual(
  mapHcpCatalogItem({ uuid: "0b2c1b4e-1111-2222-3333-444455556666", name: "Softener resin 1 cu ft", part_number: "RES-1", price: 18950, cost: 9000, unit_of_measure: "bag", taxable: true }, "pricebook_material"),
  { code: "RES-1", description: "Softener resin 1 cu ft", unit: "bag", price: 189.5, externalId: "pricebook_material:0b2c1b4e-1111-2222-3333-444455556666" }
);
assert.strictEqual(mapHcpCatalogItem({ uuid: "abcdef12-0000-0000-0000-000000000000", name: "Install", price: 25000 }, "organizational")?.code, "HCP-S-ABCDEF1200"); // no task_number → synthetic
assert.strictEqual(mapHcpCatalogItem({ uuid: "x", name: "Unpriced" }, "organizational"), null);
assert.strictEqual(hcpExternalId("organizational", "u1"), "organizational:u1");

// ---- quote → job line items ----
const line = (over: Partial<LineItemDto>): LineItemDto => ({
  id: "x",
  description: "Softener resin 1 cu ft",
  quantity: 2,
  unit: "EA",
  unitPrice: 189.5,
  totalPrice: 379,
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
const items = hcpLineItemsPayload(
  { chosenOptionGroup: "Option A", taxExempt: false },
  {
    lineItems: [
      line({ id: "a", pricebookCode: "RES-1" }),
      line({ id: "b", description: "Labor — install", unitPrice: 95, totalPrice: 237.5, quantity: 2.5, isLabor: true, taxable: false }),
      line({ id: "c", description: "Premium unit", optionGroup: "Option B", totalPrice: 500 }),
      line({ id: "d", description: "Site survey", optionGroup: "Option A", unitPrice: null, totalPrice: null, quantity: 1 }),
    ],
  },
  (l) => (l.pricebookCode === "RES-1" ? { id: "u-res", type: "pricebook_material" } : null)
);
// Option B (not chosen) is dropped; chosen Option A's line posts; 3 items total; cents, 2dp qty.
assert.deepStrictEqual(items, [
  { name: "Softener resin 1 cu ft", unit_price: 18950, quantity: 2, kind: "materials", taxable: true, service_item_id: "u-res", service_item_type: "pricebook_material" },
  { name: "Labor — install", unit_price: 9500, quantity: 2.5, kind: "labor", taxable: false },
  { name: "Site survey — price pending", unit_price: 0, quantity: 1, kind: "materials", taxable: true },
]);
// Tax-exempt quote → every line untaxable.
assert.ok(hcpLineItemsPayload({ chosenOptionGroup: null, taxExempt: true }, { lineItems: [line({})] }).every((i) => i.taxable === false));

console.log("ok   check-hcp: job bits, catalog item map, job line items");
