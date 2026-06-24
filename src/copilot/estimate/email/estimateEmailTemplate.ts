import type { EstimateQuote } from "../estimateQuoteSchema";
import type { QuoteHeader } from "../pdf/quoteHeader";

/**
 * Build the customer-facing estimate email (subject + HTML + plain-text) for the signed
 * quotation. The full signed quotation PDF is attached separately by the caller; this
 * body is a structured summary so the email reads well even before opening the PDF.
 */

export interface EstimateEmailInput {
  header: QuoteHeader;
  quote: EstimateQuote;
  estimateNumber: string;
}

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

const BRAND = "#d6314a";
const INK = "#222222";
const MUTED = "#777777";
const LINE = "#e2e2e2";

function money(n: number, currency = "USD"): string {
  const sym = currency === "USD" ? "$" : `${currency} `;
  return `${sym}${(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildEstimateEmail(input: EstimateEmailInput): BuiltEmail {
  const { header, quote, estimateNumber } = input;
  const currency = quote.currency || "USD";
  const company = header.companyName || "Clara AI";
  const customer = header.customerName || "there";
  const subtotal = (quote.materialsServicesSubtotal || 0) + (quote.laborSubtotal || 0);

  const subject = `Your estimate from ${company} — ${estimateNumber}`;

  const rows = quote.lineItems
    .map(
      (li) => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid ${LINE};font-size:13px;color:${INK};">
            <strong>${esc(li.code)}</strong> — ${esc(li.description)}
            <div style="color:${MUTED};font-size:11px;">${esc(li.kind)} · ${esc(li.sourceSheet)}</div>
          </td>
          <td style="padding:6px 8px;border-bottom:1px solid ${LINE};font-size:13px;color:${INK};text-align:right;white-space:nowrap;">
            ${money(li.lineTotal, currency)}
          </td>
        </tr>`
    )
    .join("");

  const totalsRow = (label: string, value: string, bold = false) => `
    <tr>
      <td style="padding:4px 8px;font-size:13px;color:${INK};text-align:right;${bold ? "font-weight:bold;" : ""}">${esc(label)}</td>
      <td style="padding:4px 8px;font-size:13px;color:${INK};text-align:right;white-space:nowrap;${bold ? "font-weight:bold;" : ""}">${value}</td>
    </tr>`;

  const notes =
    quote.customerNotes && quote.customerNotes.length
      ? `<ul style="margin:8px 0 0;padding-left:18px;color:${MUTED};font-size:12px;">${quote.customerNotes
          .map((n) => `<li>${esc(n)}</li>`)
          .join("")}</ul>`
      : "";

  const techLine = header.technicianName ? `<br/>${esc(header.technicianName)}` : "";

  const html = `
  <div style="font-family:Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:${INK};">
    <div style="border-bottom:3px solid ${BRAND};padding:16px 0;">
      <div style="font-size:20px;font-weight:bold;color:${BRAND};">${esc(company)}</div>
      <div style="font-size:12px;color:${MUTED};">${esc(header.companyAddress || "")}</div>
    </div>

    <p style="font-size:14px;">Hi ${esc(customer)},</p>
    <p style="font-size:14px;">
      Thank you — please find your estimate <strong>${esc(estimateNumber)}</strong> for
      <strong>${esc(quote.title || "the requested work")}</strong> below. The full signed
      quotation is attached as a PDF.
    </p>

    <table style="width:100%;border-collapse:collapse;margin-top:12px;">
      <thead>
        <tr>
          <th style="text-align:left;padding:6px 8px;background:#f4f4f5;font-size:12px;color:${MUTED};">Line item</th>
          <th style="text-align:right;padding:6px 8px;background:#f4f4f5;font-size:12px;color:${MUTED};">Total</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <table style="width:100%;border-collapse:collapse;margin-top:8px;">
      <tbody>
        ${totalsRow("Subtotal", money(subtotal, currency))}
        ${quote.taxOther ? totalsRow("Tax / Other", money(quote.taxOther, currency)) : ""}
        ${totalsRow("Total", money(quote.total, currency), true)}
      </tbody>
    </table>

    ${notes ? `<div style="margin-top:14px;"><div style="font-size:13px;font-weight:bold;">Notes</div>${notes}</div>` : ""}

    <p style="font-size:14px;margin-top:18px;">
      If you have any questions, just reply to this email.
    </p>
    <p style="font-size:14px;margin:0;">Best regards,<br/><strong>${esc(company)}</strong>${techLine}</p>

    <div style="margin-top:20px;border-top:1px solid ${LINE};padding-top:10px;color:${MUTED};font-size:11px;">
      Estimate ${esc(estimateNumber)} · ${esc(company)}
    </div>
  </div>`.trim();

  const textLines = [
    `Estimate ${estimateNumber} from ${company}`,
    "",
    `Hi ${customer},`,
    `Thank you. Please find your estimate for "${quote.title || "the requested work"}" below. The full signed quotation is attached as a PDF.`,
    "",
    ...quote.lineItems.map((li) => `- ${li.code} ${li.description}: ${money(li.lineTotal, currency)}`),
    "",
    `Subtotal: ${money(subtotal, currency)}`,
    ...(quote.taxOther ? [`Tax / Other: ${money(quote.taxOther, currency)}`] : []),
    `Total: ${money(quote.total, currency)}`,
    ...(quote.customerNotes && quote.customerNotes.length
      ? ["", "Notes:", ...quote.customerNotes.map((n) => `- ${n}`)]
      : []),
    "",
    "If you have any questions, just reply to this email.",
    "",
    `Best regards,`,
    company,
    ...(header.technicianName ? [header.technicianName] : []),
  ];

  return { subject, html, text: textLines.join("\n") };
}
