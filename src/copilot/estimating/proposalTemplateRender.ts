import {
  AlignmentType,
  Document,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import PDFDocument from "pdfkit";
import {
  amountInWords,
  loadLogo,
  loadPhotos,
  type ProposalInput,
  type ProposalLineItem,
} from "./proposalDocx";
import {
  blocksOrDefault,
  fillTokens,
  type BlockStyle,
  type ProposalBlock,
  type StaticPart,
  type TemplateTokens,
} from "./proposalTemplate";

/**
 * Renders a company's stored proposal template (see proposalTemplate.ts) to .docx and to PDF.
 *
 * Both functions walk the SAME block list, so the emailed PDF and the downloaded Word file
 * always carry the same content in the same order — the reason the format is stored as blocks
 * rather than as an uploaded binary.
 *
 * EVERY company renders through here (stored template or the default blocks alike) since the
 * estimate-layout default shipped (2026-08-25); the legacy proposalDocx/proposalPdf builders
 * remain only as internals this module borrows.
 */

const money = (v: number) =>
  `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Rate / Qty / Total cells for one table line, shared by both renderers. */
const lineCells = (l: ProposalLineItem) => ({
  item: [l.code, l.description].filter(Boolean).join(" - "),
  rate: l.unitPrice != null ? money(l.unitPrice) : "—",
  qty: l.quantity != null ? `${l.quantity}${l.unit ? ` ${l.unit}` : ""}` : "",
  total: l.totalPrice != null ? money(l.totalPrice) : "—",
});

const UNPRICED_NOTE = (n: number) =>
  `NOTE: ${n} line item(s) are not yet priced and are NOT included in the totals below. ` +
  `This proposal is incomplete until they are priced or removed.`;

const OPTIONS_NOTE =
  "Only one option will be selected and performed; option totals are alternatives and are " +
  "never combined with each other.";

const tokensOf = (input: ProposalInput): TemplateTokens => ({
  companyName: input.header.companyName ?? "",
  companyAddress: input.header.companyAddress ?? "",
  technicianName: input.header.technicianName ?? "",
  licenseNumber: input.header.licenseNumber ?? "",
  companyPhone: input.header.companyPhone ?? "",
  companyEmail: input.header.companyEmail ?? "",
});

/**
 * A paragraph whose text CONTAINS tokens but fills to nothing is data the company doesn't
 * have (no phone, no licence) — the whole part is skipped, label included, so no dangling
 * "Contractor License:" prints. A literally empty text with a label is different: that is a
 * deliberate label-only line and stays.
 */
const tokenLineIsEmpty = (part: StaticPart, tokens: TemplateTokens): boolean =>
  !!part.text && /\{\{\s*\w+\s*\}\}/.test(part.text) && !fillTokens(part.text, tokens).trim();

/** Block style merged with a part-level override, the part winning. */
const merge = (base?: BlockStyle, over?: BlockStyle): BlockStyle => ({ ...base, ...over });

// ---------------------------------------------------------------- docx

const DOCX_ALIGN = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
} as const;

/** docx sizes are half-points; the model stores points. */
const runProps = (s: BlockStyle) => ({
  bold: s.bold,
  italics: s.italic,
  ...(s.fontFamily ? { font: s.fontFamily } : {}),
  ...(s.fontSize ? { size: s.fontSize * 2 } : {}),
  ...(s.color ? { color: s.color } : {}),
});

const paraProps = (s: BlockStyle) => (s.align ? { alignment: DOCX_ALIGN[s.align] } : {});

function docxStaticPart(part: StaticPart, blockStyle: BlockStyle, tokens: TemplateTokens): Paragraph[] {
  if (part.format === "paragraph" && tokenLineIsEmpty(part, tokens)) return [];
  const style = merge(blockStyle, part.style);
  const label = part.label
    ? [new TextRun({ text: part.label, ...runProps({ ...style, bold: true }) })]
    : [];
  if (part.format === "paragraph") {
    const text = fillTokens(part.text ?? "", tokens);
    return [
      new Paragraph({
        ...paraProps(style),
        children: [
          ...label,
          ...(text ? [new TextRun({ text: label.length ? ` ${text}` : text, ...runProps(style) })] : []),
        ],
      }),
    ];
  }
  const items = (part.items ?? []).map((raw) => fillTokens(raw, tokens));
  return [
    ...(label.length ? [new Paragraph({ ...paraProps(style), children: label })] : []),
    ...items.map((text) =>
      part.format === "numbered"
        ? new Paragraph({
            numbering: { reference: "template-numbered", level: 0, instance: 0 },
            children: [new TextRun({ text, ...runProps(style) })],
          })
        : new Paragraph({
            bullet: { level: 0 },
            children: [new TextRun({ text, ...runProps(style) })],
          })
    ),
  ];
}

const docxHeading = (text: string, style: BlockStyle) =>
  new Paragraph({
    spacing: { before: 300, after: 150 },
    ...paraProps(style),
    children: [new TextRun({ text, underline: {}, ...runProps({ ...style, bold: true }) })],
  });

async function docxDynamic(
  block: ProposalBlock,
  input: ProposalInput,
  style: BlockStyle
): Promise<(Paragraph | Table)[]> {
  const { header } = input;
  const centered = (children: TextRun[]) =>
    new Paragraph({ alignment: AlignmentType.CENTER, children });

  switch (block.dynamic) {
    case "logo": {
      // No logo configured = no logo. The legacy builders substitute the Clara logo, but a
      // company-branded template must never print Clara's mark on a client's proposal
      // (bug report 2026-08-24: a deleted logo kept showing).
      if (!header.logoUrl) return [];
      const logo = await loadLogo(header.logoUrl);
      return [
        new Paragraph({
          alignment: style.align ? DOCX_ALIGN[style.align] : AlignmentType.CENTER,
          children: [
            new ImageRun({ data: logo.data, type: logo.type, transformation: { width: 140, height: 140 } }),
          ],
        }),
      ];
    }
    case "contactLine": {
      const contact = [header.companyPhone, header.companyEmail].filter(Boolean).join("  |  ");
      if (!contact) return [];
      return [
        new Paragraph({
          alignment: style.align ? DOCX_ALIGN[style.align] : AlignmentType.CENTER,
          children: [new TextRun({ text: contact, ...runProps({ fontSize: 9, color: "666666", ...style }) })],
        }),
      ];
    }
    case "projectBlock": {
      const customerLine = [header.customerName, header.billingAddress, header.customerPhone]
        .filter(Boolean)
        .join("  |  ");
      const dateText = input.date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      return [
        centered([new TextRun({ text: `Project: ${input.projectTitle}`, bold: true })]),
        centered([new TextRun({ text: `Customer: ${customerLine}`, bold: true })]),
        centered([new TextRun({ text: `Contractor: ${header.companyName}`, bold: true })]),
        centered([new TextRun({ text: `Date: ${dateText}`, bold: true })]),
      ];
    }
    case "scopeOfWork":
      return input.scopeSections.flatMap((section, i) => [
        new Paragraph({
          spacing: { before: i === 0 ? 0 : 200, after: 100 },
          children: [new TextRun({ text: `${i + 1}. ${section.title.toUpperCase()}`, bold: true })],
        }),
        ...section.bullets.map(
          (b) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: b })] })
        ),
      ]);
    case "lineItems": {
      const lines = input.lineItems ?? [];
      if (!lines.length) return [];
      const out: (Paragraph | Table)[] = [];
      if (input.unpricedCount)
        out.push(
          new Paragraph({
            spacing: { after: 150 },
            children: [new TextRun({ text: UNPRICED_NOTE(input.unpricedCount), bold: true, color: "C00000" })],
          })
        );
      const cell = (text: string, opts: { bold?: boolean; right?: boolean } = {}) =>
        new TableCell({
          margins: { top: 60, bottom: 60, left: 80, right: 80 },
          children: [
            new Paragraph({
              alignment: opts.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
              children: [new TextRun({ text, bold: opts.bold, size: 20, ...(style.fontFamily ? { font: style.fontFamily } : {}) })],
            }),
          ],
        });
      const itemRow = (l: ProposalLineItem) => {
        const c = lineCells(l);
        return new TableRow({
          children: [cell(c.item), cell(c.rate, { right: true }), cell(c.qty, { right: true }), cell(c.total, { right: true })],
        });
      };
      const totalRow = (label: string, amount: number) =>
        new TableRow({
          children: [cell(label, { bold: true }), cell(""), cell(""), cell(money(amount), { bold: true, right: true })],
        });
      // Option-group lines never sum into the base total (mutually exclusive alternatives) —
      // base lines and Total first, then each option's lines under its own alternative row.
      const rows = [
        new TableRow({
          tableHeader: true,
          children: [cell("Line Item", { bold: true }), cell("Rate", { bold: true, right: true }), cell("Qty", { bold: true, right: true }), cell("Total", { bold: true, right: true })],
        }),
        ...lines.filter((l) => !l.optionGroup).map(itemRow),
        totalRow("Total", input.total),
      ];
      for (const opt of input.optionTotals ?? []) {
        rows.push(...lines.filter((l) => l.optionGroup === opt.name).map(itemRow));
        rows.push(totalRow(`Option — ${opt.name} (alternative), base + option ${money(opt.combinedTotal)}`, opt.total));
      }
      out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
      if (input.optionTotals?.length)
        out.push(
          new Paragraph({
            spacing: { before: 100 },
            children: [new TextRun({ text: OPTIONS_NOTE, italics: true, size: 18 })],
          })
        );
      return out;
    }
    case "costSummary": {
      const out: Paragraph[] = [];
      if (input.unpricedCount)
        out.push(
          new Paragraph({
            spacing: { before: 300 },
            children: [
              new TextRun({
                text: UNPRICED_NOTE(input.unpricedCount),
                bold: true,
                color: "C00000",
              }),
            ],
          })
        );
      if (input.optionTotals?.length) {
        out.push(
          new Paragraph({
            spacing: { before: 300 },
            children: [
              new TextRun({ text: "BASE SCOPE TOTAL: ", bold: true }),
              new TextRun({ text: `${amountInWords(input.total)} (${money(input.total)})`, bold: true }),
            ],
          })
        );
        for (const opt of input.optionTotals) {
          out.push(
            new Paragraph({
              spacing: { before: 150 },
              children: [
                new TextRun({ text: `${opt.name.toUpperCase()} TOTAL: `, bold: true }),
                new TextRun({ text: `${amountInWords(opt.total)} (${money(opt.total)})`, bold: true }),
              ],
            }),
            new Paragraph({
              children: [
                new TextRun({
                  text: `Base Scope + ${opt.name} Combined Total: ${money(opt.combinedTotal)}`,
                  bold: true,
                }),
              ],
            })
          );
        }
        out.push(
          new Paragraph({
            spacing: { before: 150 },
            children: [
              new TextRun({
                text:
                  "Only one option will be selected and performed; option totals are alternatives " +
                  "and are never combined with each other.",
              }),
            ],
          })
        );
      } else {
        out.push(
          new Paragraph({
            spacing: { before: 300 },
            children: [
              new TextRun({ text: "COST: ", bold: true }),
              new TextRun({
                text:
                  "All the above work to be completed in a substantial and workmanlike manner in " +
                  "accordance with the scope of work for the sum of: ",
              }),
              new TextRun({ text: `${amountInWords(input.total)} (${money(input.total)}).`, bold: true }),
            ],
          })
        );
      }
      return out;
    }
    case "preparedBy":
      return [
        new Paragraph({
          children: [new TextRun({ text: header.companyName, ...runProps({ ...style, bold: true }) })],
        }),
        ...[header.companyPhone, header.companyEmail, header.technicianName]
          .filter(Boolean)
          .map((line) => new Paragraph({ children: [new TextRun({ text: line })] })),
        ...(header.licenseNumber
          ? [
              new Paragraph({
                children: [new TextRun({ text: `Contractor License: ${header.licenseNumber}` })],
              }),
            ]
          : []),
      ];
    case "photos": {
      const photos = input.photos?.length ? await loadPhotos(input.photos) : [];
      return photos.map(
        (p) =>
          new Paragraph({
            spacing: { before: 150 },
            children: [
              new ImageRun({
                data: p.data,
                type: p.type,
                transformation: { width: p.width, height: p.height },
              }),
            ],
          })
      );
    }
    default:
      return [];
  }
}

export async function renderTemplatedProposalDocx(
  input: ProposalInput,
  stored: unknown
): Promise<Buffer> {
  const blocks = blocksOrDefault(stored);
  const tokens = tokensOf(input);
  const children: (Paragraph | Table)[] = [];
  for (const block of blocks) {
    if (!block.visible) continue;
    const style = block.style ?? {};
    // A dynamic block with nothing to show (no photos, no options) must not leave its heading
    // stranded on the page, so the heading is emitted only once the body is known non-empty.
    const body = block.dynamic
      ? await docxDynamic(block, input, style)
      : (block.content ?? []).flatMap((p) => docxStaticPart(p, style, tokens));
    if (body.length === 0) continue;
    if (block.heading) children.push(docxHeading(block.heading, style));
    children.push(...body);
  }
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "template-numbered",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------- pdf

const MARGIN = 54;
const PAGE_W = 612;
const PAGE_H = 792;
const CONTENT_W = PAGE_W - MARGIN * 2;
const INK = "#222222";

/** pdfkit ships Helvetica/Times/Courier only; anything else falls back rather than throwing. */
const PDF_FONTS: Record<string, { normal: string; bold: string; italic: string }> = {
  helvetica: { normal: "Helvetica", bold: "Helvetica-Bold", italic: "Helvetica-Oblique" },
  arial: { normal: "Helvetica", bold: "Helvetica-Bold", italic: "Helvetica-Oblique" },
  times: { normal: "Times-Roman", bold: "Times-Bold", italic: "Times-Italic" },
  "times new roman": { normal: "Times-Roman", bold: "Times-Bold", italic: "Times-Italic" },
  courier: { normal: "Courier", bold: "Courier-Bold", italic: "Courier-Oblique" },
};

function pdfFont(style: BlockStyle): string {
  const family = PDF_FONTS[(style.fontFamily ?? "helvetica").toLowerCase()] ?? PDF_FONTS.helvetica;
  if (style.bold) return family.bold;
  if (style.italic) return family.italic;
  return family.normal;
}

export async function renderTemplatedProposalPdf(
  input: ProposalInput,
  stored: unknown
): Promise<Buffer> {
  const blocks = blocksOrDefault(stored);
  const tokens = tokensOf(input);
  const { header } = input;
  const logo = header.logoUrl ? await loadLogo(header.logoUrl) : null;
  const photos = input.photos?.length ? await loadPhotos(input.photos) : [];

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "LETTER", margin: MARGIN });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const write = (text: string, style: BlockStyle, opts: { indent?: number } = {}) =>
        doc
          .font(pdfFont(style))
          .fontSize(style.fontSize ?? 10)
          .fillColor(style.color ? `#${style.color}` : INK)
          .text(text, MARGIN + (opts.indent ?? 0), doc.y, {
            width: CONTENT_W - (opts.indent ?? 0),
            align: style.align ?? "left",
          });

      const heading = (text: string) => {
        doc.moveDown(1);
        doc
          .font("Helvetica-Bold")
          .fontSize(11)
          .fillColor(INK)
          .text(text, MARGIN, doc.y, { width: CONTENT_W, underline: true });
        doc.moveDown(0.4);
      };

      const staticPart = (part: StaticPart, blockStyle: BlockStyle) => {
        if (part.format === "paragraph" && tokenLineIsEmpty(part, tokens)) return;
        const style = merge(blockStyle, part.style);
        if (part.label) write(part.label, { ...style, bold: true });
        if (part.format === "paragraph") {
          const text = fillTokens(part.text ?? "", tokens);
          if (text) write(text, style);
        } else {
          (part.items ?? []).forEach((raw, i) => {
            const marker = part.format === "numbered" ? `${i + 1}.` : "•";
            write(`${marker}  ${fillTokens(raw, tokens)}`, style, { indent: 18 });
          });
        }
        doc.moveDown(0.3);
      };

      const dynamic = (block: ProposalBlock, style: BlockStyle): boolean => {
        switch (block.dynamic) {
          case "logo": {
            if (!logo) return false;
            const x =
              style.align === "left" ? MARGIN : style.align === "right" ? PAGE_W - MARGIN - 90 : (PAGE_W - 90) / 2;
            doc.image(logo.data, x, doc.y, { fit: [90, 90] });
            doc.y += 96;
            return true;
          }
          case "contactLine": {
            const contact = [header.companyPhone, header.companyEmail].filter(Boolean).join("  |  ");
            if (!contact) return false;
            write(contact, { align: "center", fontSize: 9, color: "666666", ...style });
            doc.moveDown(0.3);
            return true;
          }
          case "projectBlock": {
            const customerLine = [header.customerName, header.billingAddress, header.customerPhone]
              .filter(Boolean)
              .join("  |  ");
            const dateText = input.date.toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            });
            doc.moveDown(0.4);
            for (const line of [
              `Project: ${input.projectTitle}`,
              `Customer: ${customerLine}`,
              `Contractor: ${header.companyName}`,
              `Date: ${dateText}`,
            ])
              write(line, { align: "center", bold: true });
            return true;
          }
          case "scopeOfWork": {
            input.scopeSections.forEach((section, i) => {
              write(`${i + 1}. ${section.title.toUpperCase()}`, { bold: true });
              section.bullets.forEach((b) => write(`•  ${b}`, {}, { indent: 18 }));
              doc.moveDown(0.3);
            });
            return input.scopeSections.length > 0;
          }
          case "lineItems": {
            const lines = input.lineItems ?? [];
            if (!lines.length) return false;
            if (input.unpricedCount) {
              write(UNPRICED_NOTE(input.unpricedCount), { bold: true, color: "C00000" });
              doc.moveDown(0.3);
            }
            const colRate = 70, colQty = 55, colTotal = 75;
            const itemW = CONTENT_W - colRate - colQty - colTotal;
            const xRate = MARGIN + itemW, xQty = xRate + colRate, xTotal = xQty + colQty;
            const row = (item: string, rate: string, qty: string, total: string, bold = false) => {
              doc.font(bold ? "Helvetica-Bold" : pdfFont(style)).fontSize(9).fillColor(INK);
              const h = Math.max(doc.heightOfString(item, { width: itemW - 8 }), 10) + 8;
              if (doc.y + h > PAGE_H - MARGIN) doc.addPage();
              const y = doc.y;
              doc.text(item, MARGIN, y + 3, { width: itemW - 8 });
              doc.text(rate, xRate, y + 3, { width: colRate - 8, align: "right" });
              doc.text(qty, xQty, y + 3, { width: colQty - 8, align: "right" });
              doc.text(total, xTotal, y + 3, { width: colTotal - 8, align: "right" });
              doc.moveTo(MARGIN, y + h).lineTo(PAGE_W - MARGIN, y + h).strokeColor("#dddddd").lineWidth(0.5).stroke();
              doc.y = y + h;
              doc.x = MARGIN;
            };
            row("Line Item", "Rate", "Qty", "Total", true);
            for (const l of lines.filter((i) => !i.optionGroup)) {
              const c = lineCells(l);
              row(c.item, c.rate, c.qty, c.total);
            }
            row("Total", "", "", money(input.total), true);
            for (const opt of input.optionTotals ?? []) {
              for (const l of lines.filter((i) => i.optionGroup === opt.name)) {
                const c = lineCells(l);
                row(c.item, c.rate, c.qty, c.total);
              }
              row(`Option — ${opt.name} (alternative), base + option ${money(opt.combinedTotal)}`, "", "", money(opt.total), true);
            }
            if (input.optionTotals?.length) {
              doc.moveDown(0.3);
              write(OPTIONS_NOTE, { italic: true, fontSize: 8, color: "666666" });
            }
            doc.moveDown(0.5);
            return true;
          }
          case "costSummary": {
            if (input.unpricedCount)
              write(UNPRICED_NOTE(input.unpricedCount), { bold: true, color: "C00000" });
            if (input.optionTotals?.length) {
              write(
                `BASE SCOPE TOTAL: ${amountInWords(input.total)} (${money(input.total)})`,
                { bold: true }
              );
              for (const opt of input.optionTotals) {
                write(
                  `${opt.name.toUpperCase()} TOTAL: ${amountInWords(opt.total)} (${money(opt.total)})`,
                  { bold: true }
                );
                write(
                  `Base Scope + ${opt.name} Combined Total: ${money(opt.combinedTotal)}`,
                  { bold: true }
                );
              }
              write(
                "Only one option will be selected and performed; option totals are alternatives " +
                  "and are never combined with each other.",
                {}
              );
            } else {
              write(
                "COST: All the above work to be completed in a substantial and workmanlike manner " +
                  `in accordance with the scope of work for the sum of: ${amountInWords(input.total)} ` +
                  `(${money(input.total)}).`,
                {}
              );
            }
            doc.moveDown(0.3);
            return true;
          }
          case "preparedBy":
            write(header.companyName, { ...style, bold: true });
            for (const line of [header.companyPhone, header.companyEmail, header.technicianName])
              if (line) write(line, style);
            if (header.licenseNumber) write(`Contractor License: ${header.licenseNumber}`, style);
            return true;
          case "photos": {
            for (const p of photos) {
              // pdfkit does not paginate images — break the page by hand when one won't fit.
              if (doc.y + p.height > PAGE_H - MARGIN) doc.addPage();
              doc.image(p.data, MARGIN, doc.y, { fit: [p.width, p.height] });
              doc.y += p.height + 10;
            }
            return photos.length > 0;
          }
          default:
            return false;
        }
      };

      for (const block of blocks) {
        if (!block.visible) continue;
        const style = block.style ?? {};
        if (block.dynamic) {
          // Heading is written by the block itself only when it has content, so an empty
          // photos/options section leaves no orphan header behind.
          const probe = block.dynamic;
          const hasContent =
            probe === "photos"
              ? photos.length > 0
              : probe === "scopeOfWork"
              ? input.scopeSections.length > 0
              : probe === "lineItems"
              ? (input.lineItems?.length ?? 0) > 0
              : true;
          if (!hasContent) continue;
          if (block.heading) heading(block.heading);
          dynamic(block, style);
        } else {
          const parts = block.content ?? [];
          if (parts.length === 0) continue;
          if (block.heading) heading(block.heading);
          parts.forEach((p) => staticPart(p, style));
        }
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
