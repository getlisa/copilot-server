import type { ProposalInput, ProposalOptionTotal } from "./proposalDocx";

/**
 * The tax-aware figures every proposal document must agree on (T-62).
 *
 * These exist as one helper rather than as arithmetic repeated at each render site because the
 * documents built from `ProposalInput` are the ones a customer SIGNS. The bid PDF, the uploaded
 * .docx template and the estimate layout each print a "COST"/"Total"/"for the sum of" line, and
 * each spells the figure out in words above a signature. Ten independent expressions of
 * "total plus tax" is ten chances for one of them to stay pre-tax, and the failure is invisible:
 * the document renders perfectly, the customer signs it, and QuickBooks bills a different number.
 */

/** Whether a rate is configured at all. Null rate and a 0% rate are different states. */
export const isTaxed = (input: Pick<ProposalInput, "taxRatePercent">): boolean =>
  input.taxRatePercent != null;

/**
 * The amount payable — what belongs on a contractual line and in `amountInWords`.
 * Falls back to the pre-tax total when no rate applies, so an untaxed quote is unchanged.
 */
export const payable = (input: Pick<ProposalInput, "total" | "totalWithTax" | "taxRatePercent">): number =>
  isTaxed(input) ? (input.totalWithTax ?? input.total) : input.total;

/** Payable for one option: base + that option, tax included when a rate applies. */
export const optionPayable = (
  input: Pick<ProposalInput, "taxRatePercent">,
  opt: ProposalOptionTotal
): number => (isTaxed(input) ? (opt.combinedTotalWithTax ?? opt.combinedTotal) : opt.combinedTotal);

/**
 * The label for a tax row, or null when none should be rendered.
 *
 * Keyed on the RATE, not on a non-zero amount. A company that configured 0% has made a decision
 * the customer is entitled to see stated; printing nothing reads as "tax was not considered".
 */
export const taxRowLabel = (input: Pick<ProposalInput, "taxRatePercent">): string | null =>
  input.taxRatePercent == null ? null : `Sales tax (${input.taxRatePercent}%)`;

/** The tax figure to print beside that label. */
export const taxRowAmount = (input: Pick<ProposalInput, "taxAmount">): number => input.taxAmount ?? 0;

/** What the pre-tax figure should be called: "Subtotal" once tax follows it, else "Total". */
export const subtotalLabel = (input: Pick<ProposalInput, "taxRatePercent">): string =>
  isTaxed(input) ? "Subtotal" : "Total";
