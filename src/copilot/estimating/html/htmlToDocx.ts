import {
  AlignmentType,
  BorderStyle,
  ImageRun,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
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

export interface DocCell {
  nodes: DocNode[];
  shading?: string;
  /** Percentage of the table width. */
  width?: number;
}

export interface DocTable {
  kind: "table";
  rows: DocCell[][];
  /** A layout table (a flex row) prints no borders; a real one keeps them. */
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

  const tableNode = (el: any): DocTable => {
    const rows: DocCell[][] = [];
    const total = el.getBoundingClientRect().width || 1;
    for (const tr of Array.from(el.querySelectorAll("tr")) as any[]) {
      if (!visible(tr)) continue;
      const cells: DocCell[] = [];
      for (const td of Array.from(tr.children) as any[]) {
        if (!visible(td)) continue;
        cells.push({
          nodes: nodesFor(td, true),
          shading: fillOf(td),
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
   * The nodes for ONE element: recurse when it is a container, otherwise emit its own text.
   * Both callers need this — a `<td>` holding plain text has no element children at all, and
   * walking only children would render every such cell empty.
   */
  function nodesFor(el: any, inCell: boolean): DocNode[] {
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "TABLE") return [tableNode(el)];
    if (tag === "IMG") {
      const img = imageNode(el);
      return img ? [img] : [];
    }
    if (tag === "BR") return [];

    const rule = ruleOf(el);
    if (blockKidsOf(el).length > 0) {
      const nested = collect(el, inCell);
      return rule ? [{ kind: "para", runs: [], ruleAbove: rule }, ...nested] : nested;
    }
    const runs = runsOf(el);
    if (!runs.length && !rule) return [];
    return [
      {
        kind: "para",
        runs,
        align: alignOf(el),
        shading: fillOf(el),
        ...(rule ? { ruleAbove: rule } : {}),
      },
    ];
  }

  function collect(root: any, inCell = false): DocNode[] {
    const out: DocNode[] = [];
    for (const el of Array.from(root.children) as any[]) {
      if (!visible(el)) continue;
      const s = styleOf(el);
      const blockKids = blockKidsOf(el);

      // A flex ROW is the one layout Word can honestly reproduce: a borderless table, one
      // cell per child. Without this the letterhead's two columns stack and the document
      // stops looking like the customer's.
      if (
        s.display === "flex" &&
        !String(s.flexDirection).startsWith("column") &&
        blockKids.length > 1
      ) {
        const total = el.getBoundingClientRect().width || 1;
        out.push({
          kind: "table",
          borderless: true,
          rows: [
            blockKids.map((k) => ({
              nodes: nodesFor(k, true),
              shading: fillOf(k),
              width: Math.round(((k.getBoundingClientRect().width || 0) / total) * 100) || undefined,
            })),
          ],
        });
        continue;
      }

      out.push(...nodesFor(el, inCell));
    }
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

function table(node: DocTable): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    ...(node.borderless ? { borders: NO_BORDERS } : {}),
    rows: node.rows.map(
      (row) =>
        new TableRow({
          children: row.map(
            (c) =>
              new TableCell({
                ...(c.width ? { width: { size: c.width, type: WidthType.PERCENTAGE } } : {}),
                ...(c.shading ? { shading: { fill: c.shading } } : {}),
                ...(node.borderless ? { borders: NO_BORDERS } : {}),
                margins: { top: 40, bottom: 40, left: 60, right: 60 },
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
