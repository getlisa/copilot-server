import type { QuoteHeader } from "../estimate/pdf/quoteHeader";
import type { LineItemDto, QuoteOptionTotal } from "./quoteDto";

/**
 * Proposal email as a REVIEWABLE DRAFT: draftProposalEmail() produces the plain-text
 * letter the technician sees and can edit in the app; renderProposalHtml() wraps that
 * exact text in the branded HTML shell at send time (WYSIWYG — what was reviewed is
 * what is sent). The bid-proposal PDF is attached separately by the caller.
 */

export interface ProposalEmailInput {
  header: QuoteHeader;
  projectTitle: string;
  lineItems: LineItemDto[];
  /** Base scope only when optionTotals is non-empty — see QuoteDto.total. */
  total: number;
  /** Alternative options priced per choice; never summed with each other. */
  optionTotals?: QuoteOptionTotal[];
  /**
   * Company-authored body template (companies.proposal_email_template). Supports
   * {{customerName}}, {{projectTitle}}, {{companyName}}, {{technicianName}},
   * {{total}} and {{summary}} (the generated work/totals block).
   * Null/empty falls back to the built-in letter.
   */
  template?: string | null;
}

const BRAND = "#d6314a";
const INK = "#222222";
const MUTED = "#777777";
const LINE = "#e2e2e2";

const money = (n: number | null) =>
  n == null
    ? "—"
    : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The editable draft: subject + plain-text letter body. */
export function draftProposalEmail(input: ProposalEmailInput): { subject: string; body: string } {
  const { header, projectTitle, lineItems, total, optionTotals } = input;
  const company = header.companyName || "Clara AI";
  const customer = header.customerName || "Customer"; // header default is already "Customer"

  const itemLine = (li: LineItemDto) =>
    `- ${li.description}${li.quantity != null ? ` (${li.quantity}${li.unit ? " " + li.unit : ""})` : ""}: ${money(li.totalPrice)}`;
  const base = lineItems.filter((li) => !li.optionGroup);
  const totalsBlock = optionTotals?.length
    ? [
        "Summary of work (base scope):",
        ...base.map(itemLine),
        `Base scope total: ${money(total)}`,
        ...optionTotals.flatMap((opt) => [
          "",
          `${opt.name}:`,
          ...lineItems.filter((li) => li.optionGroup === opt.name).map(itemLine),
          `${opt.name} total: ${money(opt.total)} — base scope + this option: ${money(opt.combinedTotal)}`,
        ]),
        "",
        "The options above are alternatives — choose the one that fits, and the combined total shown is your full price.",
      ]
    : [
        "Summary of work:",
        ...lineItems.map(itemLine),
        `Total: ${money(total)}`,
      ];

  const summary = totalsBlock.join("\n");
  const subject = `Bid Proposal from ${company} — ${projectTitle}`;

  const vars: Record<string, string> = {
    customerName: customer,
    projectTitle,
    companyName: company,
    technicianName: header.technicianName ?? "",
    total: money(total),
    summary,
  };
  // Company template wins; the built-in letter is just the default template. Unknown
  // placeholders are left as-is so a typo is visible in the reviewable draft instead
  // of silently vanishing.
  const template = input.template?.trim() ? input.template : DEFAULT_PROPOSAL_EMAIL_TEMPLATE;
  const body = template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (raw, key: string) => (key in vars ? vars[key] : raw))
    .trimEnd(); // an empty {{technicianName}} must not leave a dangling blank line
  return { subject, body };
}

/** The built-in letter — also served to the template editor as its starting text. */
export const DEFAULT_PROPOSAL_EMAIL_TEMPLATE = [
  "Dear {{customerName}},",
  "",
  "Thank you for the opportunity to bid on {{projectTitle}}. Please find our full bid proposal attached as a PDF — it includes the detailed scope of work, exclusions, assumptions, and terms.",
  "",
  "{{summary}}",
  "",
  "We would be glad to walk you through the proposal or adjust the scope to fit your needs — just reply to this email or give us a call.",
  "",
  "Best regards,",
  "{{companyName}}",
  "{{technicianName}}",
].join("\n");

/** Wrap the (possibly edited) plain-text body in the branded HTML shell. */
export function renderProposalHtml(header: QuoteHeader, body: string): string {
  const company = header.companyName || "Clara AI";
  const contactBits = [header.companyPhone, header.companyEmail]
    .filter(Boolean)
    .map(esc)
    .join(" · ");

  return `
  <div style="font-family:Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:${INK};">
    <div style="border-bottom:3px solid ${BRAND};padding:16px 0;">
      <div style="font-size:20px;font-weight:bold;color:${BRAND};">${esc(company)}</div>
      <div style="font-size:12px;color:${MUTED};">${esc(header.companyAddress || "")}</div>
    </div>

    <div style="font-size:14px;line-height:1.6;white-space:pre-wrap;margin-top:14px;">${esc(body)}</div>

    <div style="margin-top:20px;border-top:1px solid ${LINE};padding-top:10px;color:${MUTED};font-size:11px;">
      ${esc(company)}${contactBits ? ` · ${contactBits}` : ""}
    </div>
  </div>`.trim();
}
