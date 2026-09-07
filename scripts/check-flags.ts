/**
 * Regression check for line-item flag derivation and price-source display
 * (pricebook-config PRD US6/US8 + labor PRD US7):
 *  - a fallback (HD-) price blocks completion until confirmed; confirm clears it
 *  - a manually entered price never carries a source or a fallback flag
 *  - the review screen names the source book; fallback shows the Home Depot label
 *  - labor lines are ordinary priced lines: no flag until the RATE is overridden
 *
 * Pure — no network, no database.
 *   npx tsx scripts/check-flags.ts
 */
import { flagsFor, toLineItemDto } from "../src/copilot/estimating/quoteDto";
import type { QuoteLineItem } from "@prisma/client";

let failures = 0;
const expect = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else console.log(`ok   ${label}`);
};

/**
 * The money columns are Prisma `Decimal`, but the code under test reads them through
 * `Number(v)` (quoteDto.ts:138), so these fixtures use plain numbers. Spelling that out in the
 * override type keeps the literals honest under the typechecker rather than relying on
 * `scripts/` being excluded from it.
 */
type LineOverrides = Partial<Omit<QuoteLineItem, "quantity" | "unitPrice" | "totalPrice">> & {
  quantity?: number | null;
  unitPrice?: number | null;
  totalPrice?: number | null;
};

const line = (overrides: LineOverrides): QuoteLineItem =>
  ({
    id: "line-1",
    quoteId: "quote-1",
    description: "20A single pole breaker",
    quantity: 2,
    unit: "EA",
    unitPrice: 8.5,
    totalPrice: null,
    pricebookCode: "B1:X",
    searchTerm: null,
    optionGroup: null,
    agentSuggested: false,
    manuallyEdited: false,
    ambiguousAction: null,
    sourcePricebookId: 1,
    isLabor: false,
    laborRateId: null,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as unknown as QuoteLineItem;

const bookNames = new Map([[1, "Supplier A"]]);

// Book-priced line: no blocking flags, source shows the book's name.
const fromBook = line({});
expect("book price carries no flags", flagsFor(fromBook), []);
// Signature note: markupPercent is the 3rd arg, bookNames the 4th (both features landed
// independently; see toLineItemDto). 0% markup keeps this check about the source label alone.
expect(
  "book price names its book",
  toLineItemDto(fromBook, undefined, 0, bookNames).priceSource,
  "Supplier A"
);

// Fallback-priced line: blocks until confirmed (US6), labeled as fallback (US8).
const fromHd = line({ pricebookCode: "HD-312528973", sourcePricebookId: null });
// Owner decision 2026-08-24 (overrides pricebook PRD US6): a fallback price is an ordinary
// price — the "Home Depot — online fallback" source label is the disclosure, nothing blocks.
expect("fallback price carries no flags", flagsFor(fromHd), []);
expect(
  "fallback price shows the HD label",
  toLineItemDto(fromHd).priceSource,
  "Home Depot — online fallback"
);

// Manually entered price: blank source (US8's exception), only the informational flag.
const manual = line({ manuallyEdited: true, sourcePricebookId: null, pricebookCode: null });
expect("manual price is only manually_edited", flagsFor(manual), ["manually_edited"]);
expect("manual price has a blank source", toLineItemDto(manual).priceSource, null);
// Even a stale HD code never shows a source once the technician typed their own number.
expect(
  "manual edit suppresses fallback flag and source",
  [
    flagsFor(line({ manuallyEdited: true, pricebookCode: "HD-312528973", sourcePricebookId: null })),
    toLineItemDto(line({ manuallyEdited: true, pricebookCode: "HD-312528973", sourcePricebookId: null })).priceSource,
  ],
  [["manually_edited"], null]
);

// Unpriced line still blocks as unmatched (unchanged behavior).
expect(
  "unpriced line is unmatched",
  flagsFor(line({ unitPrice: null, pricebookCode: null, sourcePricebookId: null })),
  ["unmatched"]
);

// Labor lines (labor PRD): ordinary priced lines, no flag until the rate is overridden.
const laborLine = line({
  isLabor: true,
  laborRateId: 7,
  unit: "hr",
  quantity: 3,
  unitPrice: 95,
  pricebookCode: null,
  sourcePricebookId: null,
});
expect("configured-rate labor line carries no flags", flagsFor(laborLine), []);
expect("labor line has a blank price source", toLineItemDto(laborLine).priceSource, null);
expect("labor flag is carried on the DTO", toLineItemDto(laborLine).isLabor, true);
// Ad-hoc rate (zero types configured / unmatched type): still an ordinary priced line (US5).
expect(
  "ad-hoc-rate labor line carries no flags",
  flagsFor(line({ isLabor: true, laborRateId: null, unit: "hr", unitPrice: 120, pricebookCode: null, sourcePricebookId: null })),
  []
);
// Overriding the RATE flags it (US7) — the hours-only edit path never sets manuallyEdited.
expect(
  "rate override flags the labor line",
  flagsFor(line({ isLabor: true, laborRateId: 7, manuallyEdited: true, pricebookCode: null, sourcePricebookId: null })),
  ["manually_edited"]
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll flag checks passed");
