import type { QuoteHeader } from "../estimate/pdf/quoteHeader";
import type { LineItemDto } from "./quoteDto";

/**
 * Proposal email as a REVIEWABLE DRAFT: draftProposalEmail() produces the plain-text
 * letter the technician sees and can edit in the app; renderProposalHtml() wraps that
 * exact text in the branded HTML shell at send time (WYSIWYG — what was reviewed is
 * what is sent). The bid-proposal DOCX is attached separately by the caller.
 */

export interface ProposalEmailInput {
  header: QuoteHeader;
  projectTitle: string;
  lineItems: LineItemDto[];
  total: number;
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
  const { header, projectTitle, lineItems, total } = input;
  const company = header.companyName || "Clara AI";
  const customer = header.customerName !== "Customer" ? header.customerName : "there";

  const body = [
    `Dear ${customer},`,
    "",
    `Thank you for the opportunity to bid on ${projectTitle}. Please find our full bid proposal attached as a Word document — it includes the detailed scope of work, exclusions, assumptions, and terms.`,
    "",
    "Summary of work:",
    ...lineItems.map(
      (li) =>
        `- ${li.description}${li.quantity != null ? ` (${li.quantity}${li.unit ? " " + li.unit : ""})` : ""}: ${money(li.totalPrice)}`
    ),
    `Total: ${money(total)}`,
    "",
    "We would be glad to walk you through the proposal or adjust the scope to fit your needs — just reply to this email or give us a call.",
    "",
    "Best regards,",
    company,
    ...(header.technicianName ? [header.technicianName] : []),
  ].join("\n");

  return { subject: `Bid Proposal from ${company} — ${projectTitle}`, body };
}

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
