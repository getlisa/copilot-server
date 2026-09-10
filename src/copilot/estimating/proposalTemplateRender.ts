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
  payable,
  optionPayable,
  taxRowLabel,
  taxRowAmount,
  subtotalLabel,
} from "./proposalTotals";
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
  logoSizeOf,
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

/** "C00000" or "#C00000" → "#C00000"; undefined → null. */
const hexOf = (c?: string): string | null => (c ? (c.startsWith("#") ? c : `#${c}`) : null);

/**
 * The document's ACCENT color: the first block-level style.color in the template (hidden
 * blocks count, so a template can carry a non-rendering "theme" block). One color set once
 * themes the whole document — section headings, table header rows, the totals row, info-box
 * bars and the footer rule — which is how the imported NLFP-style proposals get their brand
 * red everywhere without styling every block by hand. No color anywhere = the neutral
 * rendering every company had before.
 */
const accentOf = (blocks: ProposalBlock[]): string | null => {
  for (const b of blocks) {
    const c = hexOf(b.style?.color);
    if (c) return c;
  }
  return null;
};

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

const docxHeading = (text: string, style: BlockStyle, accent?: string | null) =>
  new Paragraph({
    spacing: { before: 300, after: 150 },
    ...paraProps(style),
    children: [
      new TextRun({
        text,
        underline: {},
        ...runProps({ ...style, bold: true, color: style.color ?? (accent ? accent.replace("#", "") : undefined) }),
      }),
    ],
  });

async function docxDynamic(
  block: ProposalBlock,
  input: ProposalInput,
  style: BlockStyle,
  accent?: string | null,
  allBlocks: ProposalBlock[] = []
): Promise<(Paragraph | Table)[]> {
  /** docx shading fill wants the hex without '#'. */
  const accentFill = accent ? accent.replace("#", "") : null;
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
      // Same knob as the PDF; 140/90 keeps the docx default exactly what it always was.
      const px = Math.round((logoSizeOf(block) * 140) / 90);
      return [
        new Paragraph({
          alignment: style.align ? DOCX_ALIGN[style.align] : AlignmentType.CENTER,
          children: [
            new ImageRun({ data: logo.data, type: logo.type, transformation: { width: px, height: px } }),
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
      const dateText = input.date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      if (!block.boxed) {
        // The document showed plain lines, so plain lines render.
        const customerLine = [header.customerName, header.billingAddress, header.customerPhone]
          .filter(Boolean)
          .join("  |  ");
        return [
          centered([new TextRun({ text: `Project: ${input.projectTitle}`, bold: true })]),
          centered([new TextRun({ text: `Customer: ${customerLine}`, bold: true })]),
          centered([new TextRun({ text: `Contractor: ${header.companyName}`, bold: true })]),
          centered([new TextRun({ text: `Date: ${dateText}`, bold: true })]),
        ];
      }
      // Boxed info tables, mirroring the PDF: PROPOSAL INFORMATION | project/client info,
      // each a shaded title bar over bold-label rows.
      const left: [string, string][] = [
        ["Date:", dateText],
        ["Prepared By:", header.technicianName || header.companyName || ""],
        ["Contractor:", header.companyName ?? ""],
        ...(header.licenseNumber ? ([["License #:", header.licenseNumber]] as [string, string][]) : []),
      ];
      const right: [string, string][] = [
        ["Project:", input.projectTitle],
        ["Client:", header.customerName ?? ""],
        ["Address:", header.billingAddress ?? ""],
        ...(header.customerPhone ? ([["Contact:", header.customerPhone]] as [string, string][]) : []),
      ];
      const margins = { top: 60, bottom: 60, left: 80, right: 80 };
      const barCell = (title: string) =>
        new TableCell({
          margins,
          shading: { fill: accentFill ?? "3F3F3F" },
          children: [
            new Paragraph({
              children: [new TextRun({ text: title, bold: true, color: "FFFFFF", size: 18 })],
            }),
          ],
        });
      const bodyCell = (rows: [string, string][]) =>
        new TableCell({
          margins,
          children: rows.map(
            ([label, value]) =>
              new Paragraph({
                spacing: { after: 80 },
                children: [
                  new TextRun({ text: `${label} `, bold: true, size: 18 }),
                  new TextRun({ text: value, size: 18 }),
                ],
              })
          ),
        });
      // Right-box title rule mirrors the PDF: the LAST boxed block's heading when the
      // document had two boxed info sections, its own otherwise.
      const boxedHeadings = allBlocks
        .filter((b) => b.dynamic === "projectBlock" && b.boxed && b.heading)
        .map((b) => b.heading!);
      const rightTitle =
        (boxedHeadings.length > 1 ? boxedHeadings[boxedHeadings.length - 1] : block.heading) ||
        "Project Information";
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: [barCell("PROPOSAL INFORMATION"), barCell(rightTitle.toUpperCase())],
            }),
            new TableRow({ children: [bodyCell(left), bodyCell(right)] }),
          ],
        }),
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
      const cell = (
        text: string,
        opts: { bold?: boolean; right?: boolean; fill?: string; color?: string } = {}
      ) =>
        new TableCell({
          margins: { top: 60, bottom: 60, left: 80, right: 80 },
          ...(opts.fill ? { shading: { fill: opts.fill } } : {}),
          children: [
            new Paragraph({
              alignment: opts.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
              children: [
                new TextRun({
                  text,
                  bold: opts.bold,
                  size: 20,
                  ...(opts.color ? { color: opts.color } : {}),
                  ...(style.fontFamily ? { font: style.fontFamily } : {}),
                }),
              ],
            }),
          ],
        });
      const itemRow = (l: ProposalLineItem) => {
        const c = lineCells(l);
        return new TableRow({
          children: [cell(c.item), cell(c.rate, { right: true }), cell(c.qty, { right: true }), cell(c.total, { right: true })],
        });
      };
      // Sample-style shading, mirroring the PDF: light bands for subtotal/tax, accent-filled
      // final Total with white text. Neutral (no accent) keeps the old plain bold rows.
      const totalRow = (label: string, amount: number, kind: "band" | "total" = "band") => {
        const fill = accentFill ? (kind === "total" ? accentFill : "F2F2F2") : undefined;
        const color = accentFill && kind === "total" ? "FFFFFF" : undefined;
        return new TableRow({
          children: [
            cell(label, { bold: true, fill, color }),
            cell("", { fill }),
            cell("", { fill }),
            cell(money(amount), { bold: true, right: true, fill, color }),
          ],
        });
      };
      // Option-group lines never sum into the base total (mutually exclusive alternatives) —
      // base lines and Total first, then each option's lines under its own alternative row.
      const headerCell = (text: string, right = false) =>
        cell(text, { bold: true, right, fill: accentFill ?? "3F3F3F", color: "FFFFFF" });
      const rows = [
        new TableRow({
          tableHeader: true,
          children: [headerCell("Line Item"), headerCell("Rate", true), headerCell("Qty", true), headerCell("Total", true)],
        }),
        ...lines.filter((l) => !l.optionGroup).map(itemRow),
        // Subtotal / tax / Total once a rate applies — printing "Total" above a tax row and a
        // larger figure below it reads as an error in the document.
        ...(taxRowLabel(input)
          ? [
              totalRow(subtotalLabel(input), input.total),
              totalRow(taxRowLabel(input)!, taxRowAmount(input)),
              totalRow("Total", payable(input), "total"),
            ]
          : [totalRow(subtotalLabel(input), input.total, "total")]),
      ];
      for (const opt of input.optionTotals ?? []) {
        rows.push(...lines.filter((l) => l.optionGroup === opt.name).map(itemRow));
        rows.push(
          totalRow(
            `Option — ${opt.name} (alternative), base + option ${money(optionPayable(input, opt))}`,
            opt.total
          )
        );
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
              new TextRun({
                text: `${amountInWords(payable(input))} (${money(payable(input))})`,
                bold: true,
              }),
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
                  text:
                    `Base Scope + ${opt.name} Combined Total: ${money(optionPayable(input, opt))}` +
                    (taxRowLabel(input) ? ` (includes ${money(opt.taxAmount ?? 0)} sales tax)` : ""),
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
              new TextRun({
                text:
                  `${amountInWords(payable(input))} (${money(payable(input))})` +
                  `${taxRowLabel(input) ? ", sales tax included" : ""}.`,
                bold: true,
              }),
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
  const accent = accentOf(blocks);
  const children: (Paragraph | Table)[] = [];
  // Only the first projectBlock/lineItems occurrence renders — see the PDF renderer's note
  // on imported documents that carry several info boxes or tables of the same kind.
  const firstIdOf = (t: string) => blocks.find((b) => b.dynamic === t)?.id;
  const dupDynamic = (b: ProposalBlock) =>
    (b.dynamic === "projectBlock" || b.dynamic === "lineItems") && b.id !== firstIdOf(b.dynamic);
  for (const block of blocks) {
    if (!block.visible) continue;
    if (dupDynamic(block)) continue;
    const style = block.style ?? {};
    // A dynamic block with nothing to show (no photos, no options) must not leave its heading
    // stranded on the page, so the heading is emitted only once the body is known non-empty.
    const body = block.dynamic
      ? await docxDynamic(block, input, style, accent, blocks)
      : (block.content ?? []).flatMap((p) => docxStaticPart(p, style, tokens));
    if (body.length === 0) continue;
    // Boxed projectBlock carries its titles in its own bars — no duplicate heading.
    if (block.heading && !(block.dynamic === "projectBlock" && block.boxed))
      children.push(docxHeading(block.heading, style, accent));
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

      const accent = accentOf(blocks);

      // Branded footer on every page: accent rule + the company contact line, centered —
      // the samples carry it on each page. Drawn at an absolute position below the content
      // area; cursor saved/restored so mid-flow page breaks are unaffected.
      const footerText = [header.companyName, header.companyPhone, header.companyEmail]
        .filter(Boolean)
        .join("  |  ");
      const footer = () => {
        if (!footerText) return;
        const keep = { x: doc.x, y: doc.y };
        // Writing below the bottom margin makes pdfkit auto-page, which fires pageAdded,
        // which draws the footer… (a live stack overflow). Zero the margin while drawing.
        const keepBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        const fy = PAGE_H - 34;
        if (accent)
          doc.moveTo(MARGIN, fy - 4).lineTo(PAGE_W - MARGIN, fy - 4).strokeColor(accent).lineWidth(1).stroke();
        doc
          .font("Helvetica")
          .fontSize(7.5)
          .fillColor("#888888")
          .text(footerText, MARGIN, fy, { width: CONTENT_W, align: "center", lineBreak: false });
        doc.page.margins.bottom = keepBottom;
        doc.x = keep.x;
        doc.y = keep.y;
      };
      doc.on("pageAdded", footer);
      footer();

      const write = (text: string, style: BlockStyle, opts: { indent?: number } = {}) =>
        doc
          .font(pdfFont(style))
          .fontSize(style.fontSize ?? 10)
          .fillColor(style.color ? `#${style.color}` : INK)
          .text(text, MARGIN + (opts.indent ?? 0), doc.y, {
            width: CONTENT_W - (opts.indent ?? 0),
            align: style.align ?? "left",
          });

      const heading = (text: string, style: BlockStyle = {}) => {
        doc.moveDown(1);
        doc
          .font("Helvetica-Bold")
          .fontSize(style.fontSize ?? 11)
          .fillColor(hexOf(style.color) ?? accent ?? INK)
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
            const size = logoSizeOf(block);
            const x =
              style.align === "left"
                ? MARGIN
                : style.align === "right"
                ? PAGE_W - MARGIN - size
                : (PAGE_W - size) / 2;
            doc.image(logo.data, x, doc.y, { fit: [size, size] });
            doc.y += size + 6;
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
            const dateText = input.date.toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            });
            if (!block.boxed) {
              // The document showed plain lines, so plain lines render.
              const customerLine = [header.customerName, header.billingAddress, header.customerPhone]
                .filter(Boolean)
                .join("  |  ");
              doc.moveDown(0.4);
              for (const [label, value] of [
                ["Project:", input.projectTitle],
                ["Customer:", customerLine],
                ["Contractor:", header.companyName ?? ""],
                ["Date:", dateText],
              ])
                write(`${label} ${value}`, { align: "center", bold: true });
              return true;
            }
            // The document carried boxed info tables: two boxes side by side, sample-style —
            // PROPOSAL INFORMATION on the left, the project/client box on the right, each a
            // colored header bar (accent when themed, dark grey otherwise) over a bold label
            // column with hairline rows.
            const left: [string, string][] = [
              ["Date:", dateText],
              ["Prepared By:", header.technicianName || header.companyName || ""],
              ["Contractor:", header.companyName ?? ""],
              ...(header.licenseNumber ? ([["License #:", header.licenseNumber]] as [string, string][]) : []),
            ];
            const right: [string, string][] = [
              ["Project:", input.projectTitle],
              ["Client:", header.customerName ?? ""],
              ["Address:", header.billingAddress ?? ""],
              ...(header.customerPhone ? ([["Contact:", header.customerPhone]] as [string, string][]) : []),
            ];
            const bar = accent ?? "#3f3f3f";
            const gap = 16;
            const boxW = (CONTENT_W - gap) / 2;
            const barH = 18;
            const labelW = 82;
            const rowH = (value: string) =>
              Math.max(
                doc.font("Helvetica").fontSize(9).heightOfString(value || " ", { width: boxW - labelW - 12 }),
                10
              ) + 8;
            const bodyH = (rows: [string, string][]) => rows.reduce((s, [, v]) => s + rowH(v), 0);
            const boxH = barH + Math.max(bodyH(left), bodyH(right));
            doc.moveDown(0.5);
            if (doc.y + boxH > PAGE_H - MARGIN) doc.addPage();
            const top = doc.y;
            const drawBox = (x: number, title: string, rows: [string, string][]) => {
              doc.rect(x, top, boxW, barH).fill(bar);
              // Grey label column behind the whole body, like the samples.
              doc.rect(x, top + barH, labelW, boxH - barH).fill("#F5F5F5");
              doc
                .font("Helvetica-Bold")
                .fontSize(9)
                .fillColor("#FFFFFF")
                .text(title, x + 8, top + 5, { width: boxW - 16, lineBreak: false });
              let y = top + barH;
              for (const [label, value] of rows) {
                const h = rowH(value);
                doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text(label, x + 8, y + 4, { width: labelW - 12 });
                doc.font("Helvetica").fillColor(INK).text(value, x + labelW + 4, y + 4, { width: boxW - labelW - 12 });
                y += h;
                doc.moveTo(x, y).lineTo(x + boxW, y).strokeColor("#e0e0e0").lineWidth(0.5).stroke();
              }
              doc.rect(x, top, boxW, boxH).strokeColor("#cccccc").lineWidth(0.75).stroke();
            };
            // A document with two boxed info sections classifies as two projectBlocks; the
            // pair renders once (from the first), so the right box takes the LAST boxed
            // block's heading — its own when it is the only one.
            const boxedHeadings = blocks
              .filter((b) => b.dynamic === "projectBlock" && b.boxed && b.heading)
              .map((b) => b.heading!);
            const rightTitle =
              (boxedHeadings.length > 1 ? boxedHeadings[boxedHeadings.length - 1] : block.heading) ||
              "Project Information";
            drawBox(MARGIN, "PROPOSAL INFORMATION", left);
            drawBox(MARGIN + boxW + gap, rightTitle.toUpperCase(), right);
            doc.y = top + boxH + 12;
            doc.x = MARGIN;
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
            // fill/color make the sample-style rows: accent header with white text, light-grey
            // subtotal/tax bands, and an accent-filled final Total (the row a customer's eye
            // lands on). Neutral templates (no accent) render exactly as before.
            const row = (
              item: string,
              rate: string,
              qty: string,
              total: string,
              opts: { bold?: boolean; fill?: string; color?: string } = {}
            ) => {
              doc.font(opts.bold ? "Helvetica-Bold" : pdfFont(style)).fontSize(9);
              const h = Math.max(doc.heightOfString(item, { width: itemW - 8 }), 10) + 8;
              if (doc.y + h > PAGE_H - MARGIN) doc.addPage();
              const y = doc.y;
              if (opts.fill) doc.rect(MARGIN, y, CONTENT_W, h).fill(opts.fill);
              doc.fillColor(opts.color ?? INK);
              doc.text(item, MARGIN + 4, y + 4, { width: itemW - 12 });
              doc.text(rate, xRate, y + 4, { width: colRate - 8, align: "right" });
              doc.text(qty, xQty, y + 4, { width: colQty - 8, align: "right" });
              doc.text(total, xTotal, y + 4, { width: colTotal - 8, align: "right" });
              if (!opts.fill)
                doc.moveTo(MARGIN, y + h).lineTo(PAGE_W - MARGIN, y + h).strokeColor("#dddddd").lineWidth(0.5).stroke();
              doc.y = y + h;
              doc.x = MARGIN;
            };
            // The header row is always a filled bar — unfilled bold text reads as a stray
            // line, not column names (user report 2026-09-10).
            const headerStyle = { bold: true, fill: accent ?? "#3f3f3f", color: "#FFFFFF" };
            const bandStyle = accent ? { bold: true, fill: "#F2F2F2" } : { bold: true };
            const totalStyle = accent
              ? { bold: true, fill: accent, color: "#FFFFFF" }
              : { bold: true };
            row("Line Item", "Rate", "Qty", "Total", headerStyle);
            for (const l of lines.filter((i) => !i.optionGroup)) {
              const c = lineCells(l);
              row(c.item, c.rate, c.qty, c.total);
            }
            // The single-total case IS the final total — accent it; with tax rows the bands
            // build up to the accented Total.
            if (taxRowLabel(input)) {
              row(subtotalLabel(input), "", "", money(input.total), bandStyle);
              row(taxRowLabel(input)!, "", "", money(taxRowAmount(input)), bandStyle);
              row("Total", "", "", money(payable(input)), totalStyle);
            } else {
              row(subtotalLabel(input), "", "", money(input.total), totalStyle);
            }
            for (const opt of input.optionTotals ?? []) {
              for (const l of lines.filter((i) => i.optionGroup === opt.name)) {
                const c = lineCells(l);
                row(c.item, c.rate, c.qty, c.total);
              }
              row(`Option — ${opt.name} (alternative), base + option ${money(opt.combinedTotal)}`, "", "", money(opt.total), bandStyle);
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
                `BASE SCOPE TOTAL: ${amountInWords(payable(input))} (${money(payable(input))})`,
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
                  `in accordance with the scope of work for the sum of: ${amountInWords(payable(input))} ` +
                  `(${money(payable(input))})${taxRowLabel(input) ? ", sales tax included" : ""}.`,
                {}
              );
            }
            doc.moveDown(0.3);
            return true;
          }
          case "preparedBy": {
            // Sample-style signature area: submitted-by on the left, client acceptance with
            // real signature rules on the right, both anchored to the same baseline — the
            // misaligned stack this replaces was a straight list of lines.
            const colW = CONTENT_W / 2 - 16;
            const leftX = MARGIN;
            const rightX = MARGIN + CONTENT_W / 2 + 16;
            if (doc.y > PAGE_H - MARGIN - 140) doc.addPage();
            doc.moveDown(0.8);
            const top = doc.y;
            // left column
            doc.font("Helvetica").fontSize(8).fillColor("#777777")
              .text("Respectfully Submitted,", leftX, top, { width: colW });
            let ly = doc.y + 10;
            doc.font("Helvetica-Bold").fontSize(10).fillColor(INK)
              .text(header.technicianName || header.companyName, leftX, ly, { width: colW });
            ly = doc.y;
            doc.font("Helvetica").fontSize(9).fillColor(INK);
            for (const line of [
              header.technicianName ? header.companyName : null,
              header.companyPhone,
              header.companyEmail,
              header.licenseNumber ? `Contractor License: ${header.licenseNumber}` : null,
            ])
              if (line) {
                doc.text(line, leftX, ly, { width: colW });
                ly = doc.y;
              }
            // right column
            doc.font("Helvetica").fontSize(8).fillColor("#777777")
              .text("Client Acceptance:", rightX, top, { width: colW });
            let ry = top + 46;
            doc.moveTo(rightX, ry).lineTo(rightX + colW, ry).strokeColor("#555555").lineWidth(0.8).stroke();
            doc.fontSize(8).fillColor("#777777").text(
              `Authorized Signature${header.customerName ? ` — ${header.customerName}` : ""}`,
              rightX, ry + 4, { width: colW });
            ry += 40;
            doc.moveTo(rightX, ry).lineTo(rightX + colW, ry).strokeColor("#555555").lineWidth(0.8).stroke();
            doc.fontSize(8).fillColor("#777777")
              .text("Print Name / Title  |  Date", rightX, ry + 4, { width: colW });
            doc.y = Math.max(ly, ry + 18);
            doc.x = MARGIN;
            return true;
          }
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

      // An imported document can carry several info boxes or tables (client info + system
      // details, deficiency table + pricing table) that classify as the same dynamic type.
      // Each type renders the same quote data every time, so only the first occurrence prints.
      const firstIdOf = (t: string) => blocks.find((b) => b.dynamic === t)?.id;
      const dupDynamic = (b: ProposalBlock) =>
        (b.dynamic === "projectBlock" || b.dynamic === "lineItems") && b.id !== firstIdOf(b.dynamic);
      for (const block of blocks) {
        if (!block.visible) continue;
        if (dupDynamic(block)) continue;
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
          // Boxed info boxes carry their titles in their own header bars — an underlined
          // section heading above them would print the same words twice.
          if (block.heading && !(block.dynamic === "projectBlock" && block.boxed))
            heading(block.heading, style);
          dynamic(block, style);
        } else {
          const parts = block.content ?? [];
          if (parts.length === 0) continue;
          if (block.heading) heading(block.heading, style);
          parts.forEach((p) => staticPart(p, style));
        }
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
