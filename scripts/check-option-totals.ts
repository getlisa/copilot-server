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
import { toQuoteDto } from "../src/copilot/estimating/quoteDto";

const now = new Date();
const line = (
  id: string,
  totalPrice: number | null,
  optionGroup: string | null,
  sortOrder: number
) => ({
  id,
  quoteId: "q1",
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
  sortOrder,
  createdAt: now,
  updatedAt: now,
});

const quote = {
  id: "q1",
  conversationId: "c1",
  status: "DRAFT",
  createdAt: now,
  updatedAt: now,
  completedAt: null,
  lineItems: [
    line("base-labor", 2842, null, 0),
    line("optA-trench", 588, "Option A – Trench Only", 1),
    line("optB-feeder", 1588, "Option B – Full 100A Feed", 2),
  ],
} as any;

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
});
check("Option B total", dto.optionTotals[1], {
  name: "Option B – Full 100A Feed",
  total: 1588,
  combinedTotal: 4430,
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

console.log(`\n──── ${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
