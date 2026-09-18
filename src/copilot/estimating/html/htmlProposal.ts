import { readFileSync, existsSync } from "fs";
import path from "path";
import logger from "../../../lib/logger";
import { payable, taxRowAmount, taxRowLabel } from "../proposalTotals";
import { amountInWords, loadCompanyLogo, type ProposalInput } from "../proposalDocx";
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

/**
 * A template file name, optionally inside ONE company folder: `nlfp/inspection.html`.
 *
 * A company with a document per job type has several files, and they belong together rather
 * than loose in one directory. Exactly two segments are allowed and each is checked against a
 * plain name — `..`, absolute paths and anything else cannot escape the templates directory,
 * which matters because the name reaches here from a database row.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function templatePath(file: string): string | null {
  const parts = file.split("/").filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  if (!parts.every((p) => SEGMENT.test(p) && p !== "..")) return null;
  return path.join(TEMPLATE_DIR, ...parts);
}

export function loadHtmlTemplate(file: string): string | null {
  const full = templatePath(file);
  if (!full || !existsSync(full)) {
    logger.warn("HTML proposal template missing; falling back to the block renderer", { file });
    return null;
  }
  return readFileSync(full, "utf8");
}

const money = (v: number | null | undefined): string =>
  v == null
    ? ""
    : `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** How long a proposal stands, matching the "Valid For: 30 Days" line these documents print. */
const VALIDITY_DAYS = 30;

const validUntil = (input: ProposalInput): string => {
  const d = new Date(input.date);
  d.setDate(d.getDate() + VALIDITY_DAYS);
  return d.toLocaleDateString("en-US");
};

/** A list of strings as template rows, usable as {{.}} or {{text}}. */
const bullets = (list: string[] | undefined) =>
  (list ?? []).filter((t) => t && t.trim()).map((t) => ({ ".": t, text: t }));

/**
 * The Schedule of Values: milestones captured in chat ("30% on submittal, 60% on completion,
 * 10% on acceptance") with their amounts COMPUTED from the total here.
 *
 * The percentages are the agreement; the money is arithmetic. Deriving it at render time is
 * what stops the table disagreeing with the total after a price changes — and the last row
 * absorbs the rounding, so the milestones always add up to exactly what is being charged.
 */
function scheduleOfValues(input: ProposalInput, total: number) {
  const raw = Array.isArray(input.milestones) ? input.milestones : [];
  const rows = raw
    .map((m) => (m && typeof m === "object" ? (m as { label?: unknown; percent?: unknown }) : null))
    .filter((m): m is { label?: unknown; percent?: unknown } => !!m)
    .map((m) => ({
      label: String(m.label ?? ""),
      percent: Number(m.percent) || 0,
    }))
    .filter((m) => m.percent > 0);
  if (!rows.length) return [];

  let allocated = 0;
  return rows.map((m, i) => {
    const amount =
      i === rows.length - 1
        ? Math.round((total - allocated) * 100) / 100
        : Math.round(total * m.percent) / 100;
    allocated += amount;
    return { n: i + 1, label: m.label, percent: `${m.percent}%`, amount: money(amount) };
  });
}

/**
 * The values a template can reference. Flat and formatted — a template author writes
 * {{total}}, never arithmetic, so the money on the page can only be the money we computed.
 */
export async function htmlTemplateData(input: ProposalInput): Promise<HtmlTemplateData> {
  const { header } = input;
  // The logo has to be INLINED, not linked. companies.logo_url is usually a bare S3 key
  // (company registration stores one when no CDN is configured), so putting it straight in
  // a src= yields a relative URL that resolves to nothing and prints a broken image. Every
  // other renderer already resolves it through loadCompanyLogo; this does the same and
  // embeds the bytes, which also means the page needs no network access to show a logo.
  const logo = await loadCompanyLogo(header.logoUrl ?? null);
  const logoUrl = logo
    ? `data:image/${logo.type === "jpg" ? "jpeg" : "png"};base64,${logo.data.toString("base64")}`
    : "";
  const taxLabel = taxRowLabel(input);
  const lineItems = (input.lineItems ?? []).map((l) => ({
    activity: l.code ?? l.description,
    description: l.code ? l.description : "",
    /**
     * The whole line as one string, for documents with a single DESCRIPTION column.
     * `activity`/`description` split a code from its text across two columns (the QuickBooks
     * layout); a template with one column that used `description` printed an empty cell for
     * every line that has no code.
     */
    item: [l.code, l.description].filter(Boolean).join(" — "),
    qty: l.quantity != null ? `${l.quantity}${l.unit ? ` ${l.unit}` : ""}` : "",
    /**
     * Labour hours on their own, for documents that price a repair by time. Only a line
     * actually billed in hours has any — a flat-rate part shows nothing rather than "1".
     */
    hours: l.isLabor && /^h(r|our)/i.test(l.unit ?? "") && l.quantity != null ? String(l.quantity) : "",
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
    logoUrl,
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

    // ---- the proposal-document fields (NLFP's letterhead and sections) --------------------
    // Every one of these is defined even when empty: an unknown token renders LITERALLY, so a
    // missing field would print "{{validUntil}}" on a customer's proposal. Sections that have
    // nothing to say are hidden with {{#name}}…{{/name}} instead.
    preparedBy: header.technicianName ?? "",
    contactName: input.contactName ?? "",
    contactPhone: header.customerPhone ?? "",
    validUntil: validUntil(input),
    validFor: `${VALIDITY_DAYS} Days`,
    systemType: "",
    clarifications: bullets(input.assumptions),
    exclusions: bullets(input.exclusions),
    milestones: scheduleOfValues(input, payable(input)),
    deficiencies: (input.deficiencies ?? []).map((d) => ({
      location: d.location ?? "",
      deficiency: d.deficiency ?? "",
      severity: d.severity ?? "",
      action: d.action ?? "",
    })),

    // {{#list}} ITERATES — it is not a show/hide test. Wrapping a section in the same name it
    // repeats inside prints that whole section once per row, so a three-milestone schedule
    // appeared three times. These booleans are what a section guard uses.
    hasClarifications: (input.assumptions ?? []).length > 0,
    hasExclusions: (input.exclusions ?? []).length > 0,
    hasMilestones: scheduleOfValues(input, payable(input)).length > 0,
    hasDeficiencies: (input.deficiencies ?? []).length > 0,
  };
}

/** Fill a named template with a quote's values. */
export async function renderHtmlProposal(file: string, input: ProposalInput): Promise<string | null> {
  const template = loadHtmlTemplate(file);
  return template ? renderHtmlTemplate(template, await htmlTemplateData(input)) : null;
}
