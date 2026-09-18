import {
  AlignmentType,
  BorderStyle,
  ImageRun,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  TableLayoutType,
  WidthType,
  type ISectionOptions,
} from "docx";
import { withProposalPage, type HtmlPdfOptions } from "./htmlToPdf";

/**
 * HTML proposal → a REAL Word document: text, tables, colours. Not a picture of one.
 *
 * WHY A BROWSER IS STILL INVOLVED. Word has no CSS, so something has to decide what a
 * template's rules actually produce — which text ends up bold, what a column's width came
 * to, which cell is filled black. Writing that means writing a CSS engine. Chromium already
 * did it, so the page is laid out there and the COMPUTED style of each element is read back;
 * the mapping below then deals in plain numbers and colours, never selectors or stylesheets.
 *
 * WHAT SURVIVES AND WHAT DOES NOT. Text, headings, tables, cell fills, column widths,
 * colours, weights, alignment and images all carry over. Flex rows become one-row tables so
 * side-by-side layout survives — the letterhead keeps the company block beside the estimate
 * panels instead of stacking. Absolute and fixed positioning does not survive; a footer
 * pinned with `position: fixed` lands in document order, once, rather than on every page.
 * That is the cost of a document you can edit, and it is why the PDF remains the exact one.
 */

/** A run of text with the formatting Word can actually express. */
export interface DocRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Points. */
  size: number;
  /** Six hex digits, no leading #. */
  color?: string;
  font?: string;
}

export interface DocPara {
  kind: "para";
  runs: DocRun[];
  align?: "left" | "center" | "right" | "justify";
  /** Cell/paragraph fill, six hex digits. */
  shading?: string;
  /** A heavy top border stands in for the template's rules and dividers. */
  ruleAbove?: { size: number; color: string };
}

export interface DocImage {
  kind: "image";
  /** base64 payload of a data: URI. */
  data: string;
  type: "png" | "jpg";
  width: number;
  height: number;
}

/** An edge Word should draw, in eighths of a point. */
export interface DocEdge {
  size: number;
  color: string;
}

export interface DocCell {
  nodes: DocNode[];
  shading?: string;
  /** Percentage of the table width. */
  width?: number;
  /**
   * The edges the CSS actually drew. Without this every table gets Word's default full grid,
   * which is the loudest thing on the page and almost never what the document asked for —
   * the estimate table draws one thin rule under each row and nothing else.
   */
  borders?: { top?: DocEdge; bottom?: DocEdge; left?: DocEdge; right?: DocEdge };
}

export interface DocTable {
  kind: "table";
  rows: DocCell[][];
  /** Layout tables (reconstructed rows) never draw edges of their own. */
  borderless?: boolean;
}

export type DocNode = DocPara | DocImage | DocTable;

// ------------------------------------------------------------------- extraction (in the page)

/**
 * Walk the laid-out document and emit the node list above.
 *
 * Runs inside the page, so it is written against `globalThis` rather than DOM types — this
 * service's tsconfig has no DOM lib, and adding one would change typings service-wide.
 */
function extractNodes(): DocNode[] {
  const g = globalThis as any;
  const doc = g.document;
  const styleOf = (el: any) => g.getComputedStyle(el);

  const hex = (colour: string): string | undefined => {
    const m = /rgba?\(([^)]+)\)/.exec(colour || "");
    if (!m) return undefined;
    const parts = m[1].split(",").map((p: string) => parseFloat(p.trim()));
    // Fully transparent is "no colour", not black.
    if (parts.length > 3 && parts[3] === 0) return undefined;
    return parts
      .slice(0, 3)
      .map((n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  };

  const BLOCKS = ["block", "flex", "grid", "list-item", "table", "flow-root"];
  const isBlock = (el: any) => BLOCKS.includes(styleOf(el).display);
  const visible = (el: any) => {
    const s = styleOf(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  };

  const runsOf = (el: any): DocRun[] => {
    const s = styleOf(el);
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return [];
    return [
      {
        text,
        bold: parseInt(s.fontWeight, 10) >= 600 || s.fontWeight === "bold",
        italic: s.fontStyle === "italic",
        // CSS px → points.
        size: Math.round(parseFloat(s.fontSize) * 0.75 * 10) / 10 || 10,
        color: hex(s.color),
        font: (s.fontFamily || "").split(",")[0].replace(/["']/g, "").trim() || undefined,
      },
    ];
  };

  const alignOf = (el: any): DocPara["align"] => {
    const a = styleOf(el).textAlign;
    if (a === "center" || a === "right" || a === "justify") return a;
    return undefined;
  };

  /** A visible fill, ignoring the page's own white. */
  const fillOf = (el: any): string | undefined => {
    const bg = hex(styleOf(el).backgroundColor);
    return bg && bg !== "FFFFFF" ? bg : undefined;
  };

  const imageNode = (el: any): DocImage | null => {
    const src: string = el.currentSrc || el.src || "";
    const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(src);
    if (!m) return null; // A remote image was blocked or never loaded; print nothing.
    const w = el.getBoundingClientRect().width || el.naturalWidth || 120;
    const h = el.getBoundingClientRect().height || el.naturalHeight || 60;
    return {
      kind: "image",
      data: m[2],
      type: m[1].toLowerCase().startsWith("jp") ? "jpg" : "png",
      width: Math.round(w),
      height: Math.round(h),
    };
  };

  /** CSS px of border → Word's eighths of a point, floored at a hairline it will still draw. */
  const edge = (widthPx: string, colour: string): DocEdge | undefined => {
    const w = parseFloat(widthPx) || 0;
    if (w <= 0) return undefined;
    return { size: Math.max(2, Math.min(48, Math.round(w * 6))), color: hex(colour) ?? "000000" };
  };

  const bordersOf = (el: any) => {
    const s = styleOf(el);
    const b = {
      top: s.borderTopStyle === "none" ? undefined : edge(s.borderTopWidth, s.borderTopColor),
      bottom: s.borderBottomStyle === "none" ? undefined : edge(s.borderBottomWidth, s.borderBottomColor),
      left: s.borderLeftStyle === "none" ? undefined : edge(s.borderLeftWidth, s.borderLeftColor),
      right: s.borderRightStyle === "none" ? undefined : edge(s.borderRightWidth, s.borderRightColor),
    };
    return b.top || b.bottom || b.left || b.right ? b : undefined;
  };

  const tableNode = (el: any): DocTable => {
    const rows: DocCell[][] = [];
    const total = el.getBoundingClientRect().width || 1;
    for (const tr of Array.from(el.querySelectorAll("tr")) as any[]) {
      if (!visible(tr)) continue;
      const cells: DocCell[] = [];
      for (const td of Array.from(tr.children) as any[]) {
        if (!visible(td)) continue;
        const fill = fillOf(td) ?? fillOf(tr);
        cells.push({
          nodes: nodesFor(td, true, fill),
          shading: fill,
          borders: bordersOf(td),
          width: Math.round(((td.getBoundingClientRect().width || 0) / total) * 100) || undefined,
        });
      }
      if (cells.length) rows.push(cells);
    }
    return { kind: "table", rows };
  };

  /** A thick border with no text is a divider, not a paragraph — keep it as a rule. */
  const ruleOf = (el: any): DocPara["ruleAbove"] => {
    const s = styleOf(el);
    const w = parseFloat(s.borderTopWidth) || 0;
    if (w < 2) return undefined;
    return { size: Math.min(24, Math.round(w * 4)), color: hex(s.borderTopColor) ?? "000000" };
  };

  const blockKidsOf = (el: any): any[] =>
    (Array.from(el.children) as any[])
      .filter(visible)
      .filter((k) => isBlock(k) || ["TABLE", "IMG"].includes((k.tagName || "").toUpperCase()));

  /**
   * Group a container's children into the visual ROWS they occupy, by geometry.
   *
   * Deliberately not "is this flex, is this grid": the letterhead has been both, and the
   * answer Word needs is the same either way — what ended up side by side. Rectangles say
   * that directly, and they say it for float, inline-block and table display too. Children
   * are taken in visual order (top, then left), so a grid whose DOM order differs from its
   * `grid-template-areas` order still reads correctly.
   */
  const rowsOf = (kids: any[]): any[][] => {
    // Zero-size children are KEPT. An empty notes column beside the totals is what holds the
    // totals over on the right; drop it and they slide back to the left margin.
    const boxes = kids
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
    const rows: { el: any; r: any }[][] = [];
    let band: { top: number; bottom: number } | null = null;
    for (const b of boxes) {
      // Same row when the box overlaps the band vertically — or simply starts level with it,
      // which is the only thing that identifies a zero-height spacer as part of the row.
      if (band && (b.r.top < band.bottom - 2 || Math.abs(b.r.top - band.top) <= 2)) {
        rows[rows.length - 1].push(b);
        band.bottom = Math.max(band.bottom, b.r.bottom);
      } else {
        rows.push([b]);
        band = { top: b.r.top, bottom: b.r.bottom };
      }
    }
    // Reading order within a row is LEFT to right, not whichever box happens to start
    // highest: a logo aligned a few pixels above the address block still belongs beside it,
    // in its own column, not in front of it.
    return rows.map((row) => row.sort((a, b) => a.r.left - b.r.left).map((b) => b.el));
  };

  /**
   * The nodes for ONE element: recurse when it is a container, otherwise emit its own text.
   * Both callers need this — a `<td>` holding plain text has no element children at all, and
   * walking only children would render every such cell empty.
   *
   * `fill` is the nearest ancestor's background. It has to be carried down: the TOTAL bar is
   * a black div whose children are floated spans, so recursing into them and forgetting the
   * parent's fill prints white text on white paper — an invisible total.
   */
  function nodesFor(el: any, inCell: boolean, fill?: string): DocNode[] {
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "TABLE") return [tableNode(el)];
    if (tag === "IMG") {
      const img = imageNode(el);
      return img ? [img] : [];
    }
    if (tag === "BR") return [];

    const own = fillOf(el) ?? fill;
    const rule = ruleOf(el);
    const kids = (Array.from(el.children) as any[]).filter(visible);
    // Recurse only into a container whose children are ALL blocks. A mixture means this is a
    // line of text that happens to contain markup — the TOTAL bar is `<span>TOTAL</span>
    // <span style="float:right">$90.14</span>`, where the float counts as a block and the
    // plain span does not. Splitting that put the label and the amount on separate lines.
    if (kids.length > 0 && blockKidsOf(el).length === kids.length) {
      const nested = collect(el, inCell, own);
      return rule ? [{ kind: "para", runs: [], ruleAbove: rule }, ...nested] : nested;
    }
    const runs = runsOf(el);
    if (!runs.length && !rule) return [];
    return [
      {
        kind: "para",
        runs,
        align: alignOf(el),
        shading: own,
        ...(rule ? { ruleAbove: rule } : {}),
      },
    ];
  }

  function collect(root: any, inCell = false, fill?: string): DocNode[] {
    const kids = blockKidsOf(root);
    const rows = rowsOf(kids);

    // Anything genuinely side by side becomes a borderless table, so the layout survives in
    // a format that has no columns of its own. All-single-child rows are ordinary stacked
    // content and stay as paragraphs.
    if (rows.some((r) => r.length > 1)) {
      const total = root.getBoundingClientRect().width || 1;
      return [
        {
          kind: "table",
          borderless: true,
          rows: rows.map((row) =>
            row.map((k) => ({
              nodes: nodesFor(k, true, fillOf(k) ?? fill),
              shading: fillOf(k) ?? fill,
              width: Math.round(((k.getBoundingClientRect().width || 0) / total) * 100) || undefined,
            }))
          ),
        },
      ];
    }

    const out: DocNode[] = [];
    for (const el of (Array.from(root.children) as any[]).filter(visible))
      out.push(...nodesFor(el, inCell, fill));
    return out;
  }

  return collect(doc.body);
}

/**
 * Read a laid-out proposal document as Word-shaped nodes.
 *
 * The extractor is shipped as SOURCE rather than as a function reference: puppeteer
 * serialises the function it is handed, and under tsx (dev, and every check script) esbuild's
 * keepNames wraps declarations in a `__name` helper that does not exist in the page — so the
 * same code that compiles fine under tsc dies with "__name is not defined". Sending the text
 * with a no-op shim makes dev and production run the identical extractor.
 */
export async function htmlToDocxNodes(
  html: string,
  opts: HtmlPdfOptions = {}
): Promise<DocNode[]> {
  return withProposalPage(html, opts, async (page) => {
    await page.setViewport({ width: 816, height: 1056 });
    const source = `(() => {
      globalThis.__name = globalThis.__name || ((fn) => fn);
      return (${extractNodes.toString()})();
    })()`;
    return (await page.evaluate(source)) as DocNode[];
  });
}

// ------------------------------------------------------------------------ mapping (pure, tested)

const ALIGN = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
} as const;

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" } as const;
const NO_BORDERS = {
  top: NO_BORDER,
  bottom: NO_BORDER,
  left: NO_BORDER,
  right: NO_BORDER,
  insideHorizontal: NO_BORDER,
  insideVertical: NO_BORDER,
};

function paragraph(node: DocPara): Paragraph {
  return new Paragraph({
    ...(node.align ? { alignment: ALIGN[node.align] } : {}),
    ...(node.shading ? { shading: { fill: node.shading } } : {}),
    ...(node.ruleAbove
      ? {
          border: {
            top: { style: BorderStyle.SINGLE, size: node.ruleAbove.size, color: node.ruleAbove.color },
          },
        }
      : {}),
    spacing: { before: 20, after: 20 },
    children: node.runs.map(
      (r) =>
        new TextRun({
          text: r.text,
          bold: r.bold,
          italics: r.italic,
          // docx sizes are half-points.
          size: Math.max(2, Math.round(r.size * 2)),
          ...(r.color ? { color: r.color } : {}),
          ...(r.font ? { font: r.font } : {}),
        })
    ),
  });
}

const edgeOf = (e?: DocEdge) =>
  e ? { style: BorderStyle.SINGLE, size: e.size, color: e.color } : NO_BORDER;

function table(node: DocTable): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    // FIXED honours the measured column widths. Left to AUTOFIT, Word re-flows them by its
    // own content rules and narrow numeric columns wrap ("1 bulb" onto two lines).
    layout: TableLayoutType.FIXED,
    // Edges are a property of the cells the CSS drew them on; the table itself never adds
    // Word's default grid on top.
    borders: NO_BORDERS,
    rows: node.rows.map(
      (row) =>
        new TableRow({
          children: row.map(
            (c) =>
              new TableCell({
                ...(c.width ? { width: { size: c.width, type: WidthType.PERCENTAGE } } : {}),
                ...(c.shading ? { shading: { fill: c.shading } } : {}),
                borders: c.borders
                  ? {
                      top: edgeOf(c.borders.top),
                      bottom: edgeOf(c.borders.bottom),
                      left: edgeOf(c.borders.left),
                      right: edgeOf(c.borders.right),
                    }
                  : NO_BORDERS,
                // Tight: Word's default cell padding plus a fixed width is what squeezes a
                // right-aligned figure into wrapping.
                margins: { top: 30, bottom: 30, left: 40, right: 40 },
                // Word requires at least one paragraph per cell.
                children: docxFromNodes(c.nodes, true) as (Paragraph | Table)[],
              })
          ),
        })
    ),
  });
}

/**
 * Nodes → docx elements. Pure, so the shape of a converted document is asserted without a
 * browser (scripts/check-html-template.ts).
 */
export function docxFromNodes(nodes: DocNode[], inCell = false): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  for (const node of nodes) {
    if (node.kind === "para") out.push(paragraph(node));
    else if (node.kind === "table") out.push(table(node));
    else
      out.push(
        new Paragraph({
          children: [
            new ImageRun({
              data: Buffer.from(node.data, "base64"),
              type: node.type === "jpg" ? "jpg" : "png",
              transformation: { width: node.width, height: node.height },
            }),
          ],
        })
      );
  }
  // A table cannot be the last thing in a cell, and an empty cell is invalid.
  if (inCell && (!out.length || out[out.length - 1] instanceof Table))
    out.push(new Paragraph({ children: [] }));
  return out;
}

/** The whole document, ready for `new Document({ sections })`. */
export function docxSection(nodes: DocNode[]): ISectionOptions {
  return {
    properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
    children: docxFromNodes(nodes),
  };
}
