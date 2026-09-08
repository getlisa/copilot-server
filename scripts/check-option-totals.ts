/**
 * Regression check for option-group quote math.
 *
 * Guards the bug this was written for: lines belonging to mutually exclusive option groups
 * were summed into one grand total — a base+A-or-B quote ($3,430 or $4,430 to the customer)
 * printed $6,591 on a real proposal. `total` must cover base-scope lines only, and each
 * option must carry its own total plus a base+option combined total.
 *
 * Pure — no network, no database.
 *   npx tsx scripts/check-option-totals.ts
 */
import type { LineItemInput, QuoteInput } from "../src/copilot/estimating/quoteDto";
import { toQuoteDto } from "../src/copilot/estimating/quoteDto";

const now = new Date();
const line = (
  id: string,
  totalPrice: number | null,
  optionGroup: string | null,
  sortOrder: number
) => ({
  id,
  description: id,
  quantity: totalPrice == null ? null : 1,
  unit: "EA",
  unitPrice: totalPrice,
  totalPrice,
  pricebookCode: null,
  searchTerm: null,
  optionGroup,
  agentSuggested: false,
  manuallyEdited: totalPrice != null, // priced lines here are technician-stated
  ambiguousAction: null,
  isLabor: false,
  sourcePricebookId: null,
  qboItemId: null,
  qboItemName: null,
  taxable: true,
  sortOrder,
}) satisfies LineItemInput;

const quote: QuoteInput = {
  id: "q1",
  conversationId: "c1",
  status: "DRAFT",
  createdAt: now,
  updatedAt: now,
  completedAt: null,
  markupPercent: 0,
  customerId: null,
  customerName: null,
  customerAddress: null,
  customerPhone: null,
  salesTaxId: null,
  taxRatePercent: null,
  chosenOptionGroup: null,
  qboEstimateId: null,
  qboSyncedAt: null,
  qboSyncError: null,
  lineItems: [
    line("base-labor", 2842, null, 0),
    line("optA-trench", 588, "Option A – Trench Only", 1),
    line("optB-feeder", 1588, "Option B – Full 100A Feed", 2),
  ],
};

const dto = toQuoteDto(quote);

let pass = 0;
let total = 0;
const check = (name: string, got: unknown, want: unknown) => {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  want=${JSON.stringify(want)} got=${JSON.stringify(got)}`);
};

check("total is base scope only, never base+A+B", dto.total, 2842);
check("two option groups detected", dto.optionTotals.length, 2);
check("Option A total", dto.optionTotals[0], {
  name: "Option A – Trench Only",
  total: 588,
  combinedTotal: 3430,
  taxAmount: 0,
  combinedTotalWithTax: 3430,
});
check("Option B total", dto.optionTotals[1], {
  name: "Option B – Full 100A Feed",
  total: 1588,
  combinedTotal: 4430,
  taxAmount: 0,
  combinedTotalWithTax: 4430,
});

// No option groups → total sums everything, optionTotals empty (pre-existing behavior).
const flat = toQuoteDto({ ...quote, lineItems: [line("a", 100, null, 0), line("b", 50, null, 1)] });
check("flat quote total unchanged", flat.total, 150);
check("flat quote has no optionTotals", flat.optionTotals, []);

// Unpriced line: excluded from totals but visible as a blocking flag — the silent-underbid guard.
const withUnpriced = toQuoteDto({
  ...quote,
  lineItems: [line("labor", 1800, null, 0), { ...line("contactor", null, null, 1), manuallyEdited: false }],
});
check("unpriced line contributes nothing to total", withUnpriced.total, 1800);
check("unpriced line raises a blocking flag", withUnpriced.blockingFlagCount >= 1, true);

// ---- sales tax on the same shape (T-62) ----
// Without a case here the suite says nothing about tax: every existing fixture carries no rate,
// so tax could be dropped entirely from the DTO and every check above would still pass.
//
// The arithmetic being pinned: tax = round2(rate% x sum of TAXABLE marked-up line totals), and
// for an option, tax is computed on base + that option AS ONE ROUNDING — not as two rounded
// halves added together, which drifts a cent against the single figure the customer is charged.
{
  const taxedQuote: QuoteInput = {
    ...quote,
    salesTaxId: 7,
    taxRatePercent: 9.1,
    lineItems: [
      line("base-materials", 1000, null, 0),
      // Labor and a permit fee are NOT taxable — the distinction the per-line toggle exists for.
      { ...line("base-labor", 500, null, 1), isLabor: true, taxable: false },
      { ...line("permit", 200, null, 2), taxable: false },
      line("optA-extra", 300, "Option A", 3),
    ],
  };
  const t = toQuoteDto(taxedQuote);

  check("base total still includes non-taxable lines", t.total, 1700);
  check("taxable subtotal excludes labor and the permit fee", t.taxableSubtotal, 1000);
  check("tax is 9.1% of the taxable part only", t.taxAmount, 91);
  check("total with tax", t.totalWithTax, 1791);
  check("option tax covers base + option taxable lines", t.optionTotals[0].taxAmount, 118.3);
  check("option payable", t.optionTotals[0].combinedTotalWithTax, 2118.3);

  // Null rate and a 0% rate are different answers, all the way through the DTO.
  const untaxed = toQuoteDto({ ...taxedQuote, salesTaxId: null, taxRatePercent: null });
  check("no rate configured leaves taxRatePercent null", untaxed.taxRatePercent, null);
  check("no rate means no tax", untaxed.taxAmount, 0);
  const zero = toQuoteDto({ ...taxedQuote, taxRatePercent: 0 });
  check("a deliberate 0% is still a rate", zero.taxRatePercent, 0);
  check("a deliberate 0% charges nothing", zero.taxAmount, 0);
}

console.log(`\n──── ${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
