import { readFileSync, existsSync } from "fs";
import path from "path";
import logger from "../../../lib/logger";
import { payable, taxRowAmount, taxRowLabel } from "../proposalTotals";
import { amountInWords, type ProposalInput } from "../proposalDocx";
import { renderHtmlTemplate, type HtmlTemplateData } from "./htmlTemplate";

/**
 * HTML proposal documents: an .html file per company, filled from a quote.
 *
 * The template FILES live in the repo (templates/*.html) because they are code-shaped
 * artefacts we hand-tune against a customer's own document. The MAPPING does not: a company
 * is linked to one by a `proposal_templates` row whose `html_file` names it — the same row
 * the chat's template ask and job-type matching already choose between. One mapping, in one
 * place, so the preview and the printed document can never disagree about which file a
 * company uses. A company with no such row keeps the block renderer.
 */

const TEMPLATE_DIR = path.join(__dirname, "templates");

export function loadHtmlTemplate(file: string): string | null {
  const full = path.join(TEMPLATE_DIR, path.basename(file));
  if (!existsSync(full)) {
    logger.warn("HTML proposal template missing; falling back to the block renderer", { file });
    return null;
  }
  return readFileSync(full, "utf8");
}

const money = (v: number | null | undefined): string =>
  v == null
    ? ""
    : `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The values a template can reference. Flat and formatted — a template author writes
 * {{total}}, never arithmetic, so the money on the page can only be the money we computed.
 */
export function htmlTemplateData(input: ProposalInput): HtmlTemplateData {
  const { header } = input;
  const taxLabel = taxRowLabel(input);
  const lineItems = (input.lineItems ?? []).map((l) => ({
    activity: l.code ?? l.description,
    description: l.code ? l.description : "",
    qty: l.quantity != null ? `${l.quantity}${l.unit ? ` ${l.unit}` : ""}` : "",
    rate: money(l.unitPrice),
    amount: money(l.totalPrice),
    // The "T" a QuickBooks estimate prints beside a taxable amount.
    taxFlag: taxLabel && l.taxable !== false ? "T" : "",
    isLabor: l.isLabor === true,
  }));
  return {
    companyName: header.companyName ?? "",
    companyAddress: header.companyAddress ?? "",
    companyCityStateZip: "",
    companyPhone: header.companyPhone ?? "",
    companyEmail: header.companyEmail ?? "",
    website: header.website ?? "",
    licenseNumber: header.licenseNumber ?? "",
    logoUrl: header.logoUrl ?? "",
    technicianName: header.technicianName ?? "",
    customerName: header.customerName ?? "",
    customerAddress: header.billingAddress ?? "",
    customerPhone: header.customerPhone ?? "",
    proposalNumber: input.proposalNumber ?? "",
    date: input.date.toLocaleDateString("en-US"),
    projectTitle: input.projectTitle,
    facility: input.facility ?? "",
    jobType: input.jobType ?? "",
    workType: input.workType ?? "",
    lineItems,
    scopeSections: input.scopeSections.map((s) => ({
      title: s.title,
      bullets: s.bullets.map((b) => ({ ".": b, text: b })),
    })),
    notes: input.notes ?? "",
    legalFooter: input.legalFooter ?? "",
    subtotal: money(input.total),
    taxed: !!taxLabel,
    taxLabel: taxLabel ?? "",
    taxAmount: money(taxRowAmount(input)),
    total: money(payable(input)),
    totalInWords: amountInWords(payable(input)),
  };
}

/** Fill a named template with a quote's values. */
export function renderHtmlProposal(file: string, input: ProposalInput): string | null {
  const template = loadHtmlTemplate(file);
  return template ? renderHtmlTemplate(template, htmlTemplateData(input)) : null;
}
