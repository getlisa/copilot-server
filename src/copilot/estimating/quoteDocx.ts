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
  WidthType,
} from "docx";
import { QuoteDto } from "./quoteDto";
import type { InvoiceBranding } from "./templates";
import { getObjectBufferFromS3 } from "../../lib/s3";
import logger from "../../lib/logger";

/**
 * Default invoice-style quote document (template-config PRD US4): every line item with
 * description/qty/price, a total, and the CLIENT's own business details in the header —
 * never Clara's. Any unconfigured branding field is simply omitted (no placeholders, no
 * errors). The document is marked according to the quote's state AT DOWNLOAD TIME:
 * DRAFT gets prominent draft banners; COMPLETED is marked completed.
 */

const money = (v: number | null) =>
  v == null ? "—" : `$${v.toFixed(2)}`;

const cell = (text: string, bold = false) =>
  new TableCell({
    width: { size: 25, type: WidthType.PERCENTAGE },
    children: [new Paragraph({ children: [new TextRun({ text, bold })] })],
  });

/**
 * The client's logo, or null when none is configured or it fails to load — the invoice
 * header omits it rather than substituting Clara's (PRD: client branding only).
 */
async function loadBrandLogo(
  logoUrl: string | null
): Promise<{ data: Buffer; type: "png" | "jpg" } | null> {
  if (!logoUrl) return null;
  const type: "png" | "jpg" = /\.jpe?g(\?|$)/i.test(logoUrl) ? "jpg" : "png";
  try {
    if (/^https?:\/\//i.test(logoUrl)) {
      const res = await fetch(logoUrl);
      if (res.ok) return { data: Buffer.from(await res.arrayBuffer()), type };
      logger.warn("Invoice logo fetch failed; omitting", { logoUrl, status: res.status });
      return null;
    }
    // A bare S3 key (stored when no public CDN is configured).
    return { data: await getObjectBufferFromS3(logoUrl), type };
  } catch (err) {
    logger.warn("Invoice logo load failed; omitting", {
      logoUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

const centered = (children: TextRun[]) =>
  new Paragraph({ alignment: AlignmentType.CENTER, children });

export async function buildQuoteDocx(quote: QuoteDto, branding?: InvoiceBranding): Promise<Buffer> {
  const isDraft = quote.status === "DRAFT";
  const created = new Date(quote.createdAt);
  const title = created.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const rows = [
    new TableRow({
      children: [
        cell("Description", true),
        cell("Qty", true),
        cell("Unit Price", true),
        cell("Total", true),
      ],
    }),
    ...quote.lineItems.map(
      (item) =>
        new TableRow({
          children: [
            cell(item.optionGroup ? `[${item.optionGroup}] ${item.description}` : item.description),
            cell(
              item.quantity == null
                ? "—"
                : `${item.quantity}${item.unit ? " " + item.unit : ""}`
            ),
            cell(money(item.unitPrice)),
            cell(money(item.totalPrice)),
          ],
        })
    ),
    new TableRow({
      children: [cell("Total", true), cell(""), cell(""), cell(money(quote.total), true)],
    }),
    // Option groups are mutually exclusive alternatives: their totals are shown per option
    // (base + option), never folded into the total above.
    ...quote.optionTotals.map(
      (opt) =>
        new TableRow({
          children: [
            cell(`${opt.name} (with base scope)`, true),
            cell(""),
            cell(""),
            cell(money(opt.combinedTotal), true),
          ],
        })
    ),
  ];

  // --- Client branding header: only what is configured renders; nothing is invented. ---
  const logo = await loadBrandLogo(branding?.logoUrl ?? null);
  const contactBits = [branding?.phone, branding?.email, branding?.website].filter(
    (v): v is string => !!v?.trim()
  );
  const brandingBlock: Paragraph[] = [
    ...(logo
      ? [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                data: logo.data,
                type: logo.type,
                transformation: { width: 120, height: 120 },
              }),
            ],
          }),
        ]
      : []),
    ...(branding?.name
      ? [centered([new TextRun({ text: branding.name, bold: true, size: 36 })])]
      : []),
    ...(branding?.address
      ? [centered([new TextRun({ text: branding.address, size: 20, color: "444444" })])]
      : []),
    ...(contactBits.length > 0
      ? [centered([new TextRun({ text: contactBits.join("  |  "), size: 20, color: "444444" })])]
      : []),
    ...(branding?.licenseNumber
      ? [
          centered([
            new TextRun({
              text: `Contractor License: ${branding.licenseNumber}`,
              size: 20,
              color: "444444",
            }),
          ]),
        ]
      : []),
    ...(brandingHasContent(branding, logo) ? [new Paragraph({ text: "" })] : []),
  ];

  const doc = new Document({
    sections: [
      {
        children: [
          ...(isDraft
            ? [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({ text: "DRAFT", bold: true, size: 72, color: "BBBBBB" }),
                  ],
                }),
              ]
            : []),
          ...brandingBlock,
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: "QUOTE", bold: true, size: 40 })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: `${title} — downloaded ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`,
                size: 20,
                color: "666666",
              }),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: isDraft
                  ? "Status: DRAFT — line items may still change."
                  : `Status: COMPLETED${quote.completedAt ? ` on ${new Date(quote.completedAt).toLocaleDateString("en-US")}` : ""}`,
                bold: true,
                size: 22,
              }),
            ],
          }),
          // Customer block (PRD US1–US3): only the fields that are set — a blank field is
          // omitted entirely, never a placeholder, and a quote with none set has no block.
          ...(quote.customerName || quote.customerAddress || quote.customerPhone
            ? [
                new Paragraph({ text: "" }),
                new Paragraph({
                  children: [new TextRun({ text: "Bill To", bold: true, size: 22 })],
                }),
                ...[quote.customerName, quote.customerAddress, quote.customerPhone]
                  .filter((v): v is string => !!v)
                  .map((v) => new Paragraph({ children: [new TextRun({ text: v, size: 22 })] })),
              ]
            : []),
          new Paragraph({ text: "" }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 4 },
              bottom: { style: BorderStyle.SINGLE, size: 4 },
              left: { style: BorderStyle.SINGLE, size: 4 },
              right: { style: BorderStyle.SINGLE, size: 4 },
              insideHorizontal: { style: BorderStyle.SINGLE, size: 2 },
              insideVertical: { style: BorderStyle.SINGLE, size: 2 },
            },
            rows,
          }),
          ...(branding?.footerTerms
            ? [
                new Paragraph({ text: "" }),
                new Paragraph({
                  children: [
                    new TextRun({ text: branding.footerTerms, size: 18, color: "444444" }),
                  ],
                }),
              ]
            : []),
          ...(isDraft
            ? [
                new Paragraph({ text: "" }),
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({
                      text: "THIS IS A DRAFT — NOT YET COMPLETED",
                      bold: true,
                    }),
                  ],
                }),
              ]
            : []),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}

function brandingHasContent(
  branding: InvoiceBranding | undefined,
  logo: unknown
): boolean {
  return !!(
    logo ||
    branding?.name ||
    branding?.address ||
    branding?.phone ||
    branding?.email ||
    branding?.website ||
    branding?.licenseNumber
  );
}
