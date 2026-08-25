import {
  AlignmentType,
  BorderStyle,
  Document,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import { CLARA_LOGO_PNG_BASE64 } from "../estimate/pdf/claraLogo";
import type { EstimateQuote } from "../estimate/estimateQuoteSchema";
import { buildQuotePdf } from "../estimate/pdf/quotePdf";
import { imageDims, loadPhotos, type ProposalInput } from "./proposalDocx";
import { validateProposalBlocks } from "./proposalTemplate";
import {
  renderTemplatedProposalDocx,
  renderTemplatedProposalPdf,
} from "./proposalTemplateRender";

/**
 * The proposal's DEFAULT document is the estimate the platform's job feature produces (owner
 * decision 2026-08-25). The PDF is rendered by the job feature's own buildQuotePdf; the .docx
 * is built here to the same layout, from the same mapped data, so the technician's Download
 * button and the emailed PDF never disagree.
 *
 * Both formats route through ONE dispatcher pair (renderProposalPdf / renderProposalDocx)
 * that takes the same branch for the same quote:
 *  - a valid stored template → the company's own blocks (the admin's customization);
 *  - a quote with option groups → the default blocks (the estimate layout has no concept of
 *    mutually-exclusive alternatives, and a plain totals column would misstate the price);
 *  - everything else → the estimate document.
 */

// Palette mirrors quotePdf.ts (docx colors carry no leading #).
const INK = "222222";
const MUTED = "777777";
const BODY = "444444";
const GREEN = "2E9E4F";
const LINE = "E2E2E2";
const HEADFILL = "F4F4F5";

const money = (n: number) =>
  `$${(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatDate = (d: Date) => {
  const date = d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
  return `${date} ${time}`;
};

const newEstimateNumber = () => `E${Date.now().toString(36).toUpperCase()}`;

/**
 * Pure mapping from the proposal input to the estimate flow's quote object — the money-
 * carrying seam between the two features. Exported for the regression check.
 */
export function mapEstimateQuote(input: ProposalInput): EstimateQuote {
  const lines = input.lineItems ?? [];
  const lineItems = lines.map((l) => ({
    sourceSheet: l.priceSource ?? (l.isLabor ? "Labor" : "Materials"),
    // The job feature prints unpriced rows as "PENDING - …" at $0.00; matching that exactly.
    code: l.code ?? (l.unmatched ? "PENDING" : ""),
    description: l.description,
    kind: (l.isLabor ? "labor" : "material") as EstimateQuote["lineItems"][number]["kind"],
    quantity: l.quantity ?? 1,
    unit: l.unit ?? "EA",
    unitPrice: l.unitPrice ?? 0,
    lineTotal: l.totalPrice ?? 0,
    isIdentifiedEquipment: false,
  }));
  const laborSubtotal = lineItems.filter((l) => l.kind === "labor").reduce((s, l) => s + l.lineTotal, 0);
  return {
    status: "estimate",
    title: input.projectTitle,
    // Required by the schema type but never rendered by either document builder.
    identifiedEquipment: { brand: "", model: "", category: "", issue: "", decision: "repair", confidence: 0 },
    lineItems,
    materialsServicesSubtotal: Math.round((input.total - laborSubtotal) * 100) / 100,
    laborSubtotal,
    taxOther: 0,
    total: input.total,
    currency: "USD",
    assumptions: input.assumptions?.length
      ? input.assumptions
      : input.scopeSections.flatMap((s) => s.bullets),
    customerNotes: input.terms ?? [],
  };
}

// ---------------------------------------------------------------------------- estimate .docx

type BorderSpec = { style: (typeof BorderStyle)[keyof typeof BorderStyle]; size: number; color: string };
type Borders = Record<"top" | "bottom" | "left" | "right" | "insideHorizontal" | "insideVertical", BorderSpec>;
const NONE: BorderSpec = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const NO_BORDERS: Borders = {
  top: NONE,
  bottom: NONE,
  left: NONE,
  right: NONE,
  insideHorizontal: NONE,
  insideVertical: NONE,
};

/** docx sizes are half-points. */
const run = (text: string, opts: { bold?: boolean; pt?: number; color?: string } = {}) =>
  new TextRun({ text, bold: opts.bold, size: (opts.pt ?? 9) * 2, color: opts.color ?? INK });

const para = (
  runs: TextRun[] | string,
  opts: { align?: (typeof AlignmentType)[keyof typeof AlignmentType]; before?: number; after?: number } = {}
) =>
  new Paragraph({
    ...(opts.align ? { alignment: opts.align } : {}),
    spacing: { before: opts.before ?? 0, after: opts.after ?? 0 },
    children: typeof runs === "string" ? [run(runs)] : runs,
  });

const cell = (
  children: Paragraph[],
  opts: { width?: number; fill?: string; borders?: Borders } = {}
) =>
  new TableCell({
    ...(opts.width ? { width: { size: opts.width, type: WidthType.PERCENTAGE } } : {}),
    ...(opts.fill ? { shading: { fill: opts.fill } } : {}),
    borders: opts.borders ?? NO_BORDERS,
    verticalAlign: VerticalAlign.TOP,
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    children,
  });

/** The estimate document as a Word file — same layout and data as buildQuotePdf's PDF. */
export async function buildEstimateStyleDocx(input: ProposalInput): Promise<Buffer> {
  const quote = mapEstimateQuote(input);
  const { header } = input;
  const estimateNumber = newEstimateNumber();

  const logoBuf = Buffer.from(CLARA_LOGO_PNG_BASE64, "base64");
  const dims = imageDims(logoBuf, "png");
  const logoW = 180;
  const logoH = dims ? Math.round((dims.height / dims.width) * logoW) : 54;

  // Header: logo left, company block right.
  const headerTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    rows: [
      new TableRow({
        children: [
          cell(
            [
              new Paragraph({
                children: [
                  new ImageRun({ data: logoBuf, type: "png", transformation: { width: logoW, height: logoH } }),
                ],
              }),
            ],
            { width: 55 }
          ),
          cell(
            [
              para([run(header.companyName, { bold: true, pt: 11 })]),
              ...[
                header.companyAddress,
                header.companyPhone ? `Phone: ${header.companyPhone}` : "",
                header.companyEmail ? `Email: ${header.companyEmail}` : "",
              ]
                .filter(Boolean)
                .map((l) => para([run(l, { color: MUTED })])),
            ],
            { width: 45 }
          ),
        ],
      }),
    ],
  });

  // Billing / Service / Date + Estimate # row.
  const addressBlock = (label: string, lines: string[]) => [
    para([run(label, { pt: 8, color: MUTED })]),
    ...lines.filter(Boolean).map((l) => para([run(l, { bold: true })])),
  ];
  const metaTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    rows: [
      new TableRow({
        children: [
          cell(addressBlock("Billing Address", [header.customerName, header.billingAddress]), { width: 34 }),
          cell(addressBlock("Service Address", [header.customerName, header.serviceAddress]), { width: 33 }),
          cell(
            [
              para([run("Date: ", { pt: 8, color: MUTED }), run(formatDate(input.date), { pt: 8, bold: true })]),
              para([run("Estimate # ", { pt: 8, color: MUTED }), run(estimateNumber, { pt: 8, bold: true })]),
            ],
            { width: 33 }
          ),
        ],
      }),
    ],
  });

  // Line-item table: same columns as the PDF, header band shaded, light row separators.
  const ROW_BORDERS: Borders = { ...NO_BORDERS, bottom: { style: BorderStyle.SINGLE, size: 4, color: LINE } };
  const headCell = (text: string, width: number, align?: (typeof AlignmentType)[keyof typeof AlignmentType]) =>
    cell([para([run(text, { bold: true, pt: 8.5, color: MUTED })], { align })], { width, fill: HEADFILL });
  const itemRows = quote.lineItems.map((li) => {
    const taxed = li.kind === "material" || li.kind === "service";
    return new TableRow({
      children: [
        cell(
          [
            para([run([li.code, li.description].filter(Boolean).join(" - "), { pt: 9.5 })]),
            para([run(`${li.kind} · ${li.sourceSheet}`, { pt: 8, color: MUTED })]),
          ],
          { width: 42, borders: ROW_BORDERS }
        ),
        cell([para("Quoted")], { width: 10, borders: ROW_BORDERS }),
        cell([para([run(money(li.unitPrice))], { align: AlignmentType.RIGHT })], { width: 12, borders: ROW_BORDERS }),
        cell(
          [para([run(`${li.quantity}${li.unit && li.unit !== "EA" ? ` ${li.unit}` : ""}`)], { align: AlignmentType.CENTER })],
          { width: 10, borders: ROW_BORDERS }
        ),
        cell(
          [
            para(
              [taxed ? run("✓", { bold: true, color: GREEN }) : run("-", { color: MUTED })],
              { align: AlignmentType.CENTER }
            ),
          ],
          { width: 10, borders: ROW_BORDERS }
        ),
        cell([para([run(money(li.lineTotal))], { align: AlignmentType.RIGHT })], { width: 16, borders: ROW_BORDERS }),
      ],
    });
  });
  const itemsTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    rows: [
      new TableRow({
        tableHeader: true,
        children: [
          headCell("Line Item", 42),
          headCell("Status", 10),
          headCell("Rate", 12, AlignmentType.RIGHT),
          headCell("Qty", 10, AlignmentType.CENTER),
          headCell("Taxed", 10, AlignmentType.CENTER),
          headCell("Total", 16, AlignmentType.RIGHT),
        ],
      }),
      ...itemRows,
    ],
  });

  // Totals, right-aligned key/value rows like the PDF's block.
  const subtotal = (quote.materialsServicesSubtotal || 0) + (quote.laborSubtotal || 0);
  const totalRow = (label: string, value: string) =>
    new TableRow({
      children: [
        cell([para("")], { width: 55 }),
        cell([para([run(label, { bold: true, pt: 9.5 })])], { width: 25, borders: ROW_BORDERS }),
        cell([para([run(value, { bold: true, pt: 9.5 })], { align: AlignmentType.RIGHT })], {
          width: 20,
          borders: ROW_BORDERS,
        }),
      ],
    });
  const totalsTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    rows: [
      totalRow("Subtotal", money(subtotal)),
      ...(quote.taxOther ? [totalRow("Tax / Other", money(quote.taxOther))] : []),
      totalRow("Total", money(quote.total)),
      totalRow("Net Amount", money(quote.total)),
    ],
  });

  const children: (Paragraph | Table)[] = [headerTable, para("", { after: 200 }), metaTable, para("", { after: 200 }), itemsTable, para("", { after: 100 }), totalsTable];

  // Signature line (proposals go out unsigned — the customer signs this document).
  children.push(
    para([run("______________________________", { color: MUTED })], { before: 400 }),
    para([run("Customer Signature", { color: MUTED })])
  );

  // Service Summary / Terms sections, same text sources as the PDF.
  const section = (title: string, lines: string[]) => {
    children.push(para([run(title, { bold: true, pt: 11 })], { before: 300, after: 80 }));
    const body = lines.filter(Boolean);
    (body.length ? body : ["—"]).forEach((l) => children.push(para([run(l, { color: BODY })])));
  };
  section("Service Summary", [quote.title, ...(quote.assumptions || [])]);
  section(
    "Terms and Conditions",
    quote.customerNotes?.length
      ? quote.customerNotes.map((n) => `• ${n}`)
      : ["Should comply with all company policies."]
  );

  if (input.photos?.length) {
    const photos = await loadPhotos(input.photos);
    if (photos.length) {
      children.push(para([run("Project Photos", { bold: true, pt: 11 })], { before: 300, after: 80 }));
      for (const p of photos)
        children.push(
          new Paragraph({
            spacing: { before: 150 },
            children: [
              new ImageRun({ data: p.data, type: p.type, transformation: { width: p.width, height: p.height } }),
            ],
          })
        );
    }
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ------------------------------------------------------------------------------- dispatchers

type RenderMode = "stored-blocks" | "default-blocks" | "estimate";

function modeFor(input: ProposalInput, stored: unknown): RenderMode {
  if (stored != null && validateProposalBlocks(stored).length === 0) return "stored-blocks";
  if (input.optionTotals?.length) return "default-blocks";
  return "estimate";
}

/** The one entry point for a proposal PDF (download, email attachment, admin preview). */
export async function renderProposalPdf(input: ProposalInput, stored: unknown): Promise<Buffer> {
  const mode = modeFor(input, stored);
  if (mode === "stored-blocks") return renderTemplatedProposalPdf(input, stored);
  if (mode === "default-blocks") return renderTemplatedProposalPdf(input, null);
  const photos = input.photos?.length ? await loadPhotos(input.photos) : [];
  return buildQuotePdf({
    quote: mapEstimateQuote(input),
    header: input.header,
    estimateNumber: newEstimateNumber(),
    date: input.date,
    photos,
  });
}

/** The one entry point for the proposal .docx — always the same branch as the PDF. */
export async function renderProposalDocx(input: ProposalInput, stored: unknown): Promise<Buffer> {
  const mode = modeFor(input, stored);
  if (mode === "stored-blocks") return renderTemplatedProposalDocx(input, stored);
  if (mode === "default-blocks") return renderTemplatedProposalDocx(input, null);
  return buildEstimateStyleDocx(input);
}
