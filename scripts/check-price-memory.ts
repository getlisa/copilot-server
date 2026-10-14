/**
 * Regression check for organization price memory (price-memory PRD):
 *  - the memory key is exact after normalization: case and whitespace never split a product
 *  - the newest active entry wins among duplicates; disabled entries are never picked
 *  - a line priced from a book (or the HD cache) is "in the pricebook"; EST/MEM/blank are not
 *  - the review screen labels a memory-priced line with who set it and when; a manual edit
 *    blanks the label like every other source
 *
 * Pure — no network, no database.
 *   npx tsx scripts/check-price-memory.ts
 */
import { indexMemory, inPriceBook, memoryKey, MEMORY_PRICE_CODE } from "../src/copilot/estimating/priceMemory";
import { toLineItemDto, type LineItemInput } from "../src/copilot/estimating/quoteDto";
import type { PriceMemory } from "@prisma/client";
import { Prisma } from "@prisma/client";

let failures = 0;
const expect = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else console.log(`ok   ${label}`);
};

// --- key normalization ---
expect("key: case-insensitive", memoryKey("PVC Pipe"), memoryKey("pvc pipe"));
expect("key: whitespace collapsed + trimmed", memoryKey("  PVC   Pipe "), "pvc pipe");
expect("key: other wording is a new product", memoryKey("PVC Pipe 3/4") === memoryKey("PVC Pipe"), false);

// --- newest active wins ---
const entry = (o: Partial<PriceMemory> & { id: number; setAt: Date }): PriceMemory => ({
  companyId: 1,
  name: "Widget",
  nameKey: "widget",
  description: null,
  rate: new Prisma.Decimal(30),
  isLabor: false,
  isActive: true,
  setByUserId: BigInt(7),
  createdAt: o.setAt,
  updatedAt: o.setAt,
  ...o,
});
const idx = indexMemory([
  entry({ id: 1, setAt: new Date("2026-10-01") }),
  entry({ id: 2, setAt: new Date("2026-10-09"), isActive: false }),
  entry({ id: 3, setAt: new Date("2026-10-05") }),
  entry({ id: 4, setAt: new Date("2026-10-08"), nameKey: "other" }),
]);
expect("index: newest ACTIVE entry wins", idx.get("widget")?.id, 3);
expect("index: disabled entries never picked", [...idx.values()].some((e) => !e.isActive), false);
expect("index: keyed per product", idx.get("other")?.id, 4);

// --- in-pricebook test (what blocks learning) ---
expect("book: named book row", inPriceBook({ pricebookCode: "B3:R12" }), true);
expect("book: HD cache row", inPriceBook({ pricebookCode: "HD-123" }), true);
expect("book: web estimate is not a book", inPriceBook({ pricebookCode: "EST" }), false);
expect("book: memory is not a book", inPriceBook({ pricebookCode: MEMORY_PRICE_CODE }), false);
expect("book: unpriced is not a book", inPriceBook({ pricebookCode: null }), false);

// --- review-screen label ---
const line = (o: Partial<LineItemInput>): LineItemInput => ({
  id: "l1",
  description: "Widget",
  quantity: 1,
  unit: "EA",
  unitPrice: 30,
  totalPrice: null,
  pricebookCode: MEMORY_PRICE_CODE,
  searchTerm: null,
  optionGroup: null,
  isLabor: false,
  agentSuggested: false,
  manuallyEdited: false,
  ambiguousAction: null,
  sourcePricebookId: null,
  priceMemoryId: 3,
  qboItemId: null,
  qboItemName: null,
  taxable: true,
  sortOrder: 0,
  ...o,
});
const sources = { memorySources: new Map([[3, "Organization memory — set by Jane Doe on Oct 8, 2026"]]) };
expect("label: memory line names setter and date", toLineItemDto(line({}), undefined, 0, sources).priceSource, "Organization memory — set by Jane Doe on Oct 8, 2026");
expect("label: generic when the index is absent", toLineItemDto(line({}), undefined, 0).priceSource, "Organization memory");
expect("label: manual edit blanks it", toLineItemDto(line({ manuallyEdited: true }), undefined, 0, sources).priceSource, null);
expect("flags: memory-priced line is not unmatched", toLineItemDto(line({})).flags, []);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll price-memory checks passed");
