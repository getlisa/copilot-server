import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { QuoteDto } from "./quoteDto";

/**
 * Basic, unstyled Word export (PRD: polished/branded export is out of scope).
 * The document is marked according to the quote's state AT DOWNLOAD TIME:
 * DRAFT gets prominent draft banners; COMPLETED is marked completed.
 */

const money = (v: number | null) =>
  v == null ? "—" : `$${v.toFixed(2)}`;

const cell = (text: string, bold = false) =>
  new TableCell({
    width: { size: 25, type: WidthType.PERCENTAGE },
    children: [new Paragraph({ children: [new TextRun({ text, bold })] })],
  });

export async function buildQuoteDocx(quote: QuoteDto): Promise<Buffer> {
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
            cell(item.description),
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
