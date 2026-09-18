import {
  AlignmentType,
  BorderStyle,
  Footer,
  Header,
  ImageRun,
  LineRuleType,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  Tab,
  TableLayoutType,
  TabStopType,
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
  /** A bottom border — an empty div with one is a signature line, not a blank paragraph. */
  ruleBelow?: { size: number; color: string };
  /**
   * Text the CSS floated to the right edge, set against a right tab stop. Keeps the TOTAL
   * bar reading `TOTAL … $225.00` across the black band rather than as one run at the left.
   */
  rightRuns?: DocRun[];
  /** The element's own vertical margin and padding, in twips. */
  spaceBefore?: number;
  spaceAfter?: number;
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
   * Columns this cell covers. The TOTAL row's label spans DESCRIPTION and QTY so the amount
   * sits under TOTAL; dropping the span put the label in column one and the amount adrift
   * across the rest, lining up with nothing above it.
   */
  span?: number;
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

/**
 * A proposal split the way Word stores one.
 *
 * The templates wrap everything in a table so a BROWSER reprints the letterhead per page.
 * Word has real header and footer parts for exactly this, so the wrapper's <thead> and
 * <tfoot> become those and repeat on every page properly — rather than being flattened into
 * the body, where they appeared once.
 */
export interface DocDocument {
  header: DocNode[];
  body: DocNode[];
  footer: DocNode[];
}

// ------------------------------------------------------------------- extraction (in the page)

/**
 * Walk the laid-out document and emit the node list above.
 *
 * Runs inside the page, so it is written against `globalThis` rather than DOM types — this
 * service's tsconfig has no DOM lib, and adding one would change typings service-wide.
 */
function extractNodes(): DocDocument {
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

  const BLOCKS = ["block", "flex", "grid", "list-item", "table", "flow-root", "inline-block"];
  const isBlock = (el: any) => BLOCKS.includes(styleOf(el).display);
  const visible = (el: any) => {
    const s = styleOf(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  };

  /** CSS px → twips (1px = 0.75pt, 1pt = 20 twips). */
  const twips = (px: string) => Math.round((parseFloat(px) || 0) * 15);

  /**
   * The element's own vertical margin and padding, as Word paragraph spacing.
   *
   * Without it every gap the template draws collapses: the estimate panels merge into one
   * black block, the blank panel runs into the table header, and the whole document rides up
   * the page. Capped, because a template using a large margin for page positioning would
   * otherwise push content onto a second sheet.
   */
  const spacingOf = (el: any): { spaceBefore?: number; spaceAfter?: number } => {
    const s = styleOf(el);
    const before = Math.min(1200, twips(s.marginTop) + twips(s.paddingTop));
    const after = Math.min(1200, twips(s.marginBottom) + twips(s.paddingBottom));
    return { ...(before ? { spaceBefore: before } : {}), ...(after ? { spaceAfter: after } : {}) };
  };

  /** `omit` drops a floated child's text, which is emitted separately against a tab stop. */
  const runsOf = (el: any, omit = ""): DocRun[] => {
    const s = styleOf(el);
    let text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (omit && text.endsWith(omit)) text = text.slice(0, -omit.length).trim();
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

  /**
   * The rows belonging to THIS table.
   *
   * querySelectorAll finds every descendant, so a table containing tables collected THEIR rows
   * too and flattened the lot into one grid — the letterhead wrapper swallowed the info boxes
   * and the pricing table, and the document came out as a wall of text followed by stray rows
   * measured against the wrong columns.
   */
  const ownRows = (el: any): any[] =>
    (Array.from(el.querySelectorAll("tr")) as any[]).filter(
      (tr) => tr.closest("table") === el && visible(tr)
    );

  /** Which section a row sits in, so a wrapper's header and footer stay in document order. */
  const sectionOf = (tr: any): string => (tr.parentElement?.tagName || "TBODY").toUpperCase();

  /**
   * A table whose body is a single cell is not a table — it is the page-layout wrapper the
   * templates use so a browser reprints the letterhead on every sheet. Word paginates its own
   * way, so it is unwrapped: the header, the document, then the footer, as ordinary content.
   * Leaving it in would put the entire proposal inside one cell, which nobody can edit.
   */
  const isPageWrapper = (el: any): boolean => {
    const body = ownRows(el).filter((tr) => sectionOf(tr) === "TBODY");
    return body.length === 1 && (Array.from(body[0].children) as any[]).filter(visible).length === 1;
  };

  const unwrapPage = (el: any, fill?: string): DocNode[] => {
    const out: DocNode[] = [];
    for (const section of ["THEAD", "TBODY", "TFOOT"]) {
      for (const tr of ownRows(el).filter((tr) => sectionOf(tr) === section))
        for (const cell of (Array.from(tr.children) as any[]).filter(visible))
          out.push(...nodesFor(cell, false, fillOf(cell) ?? fill));
    }
    return out;
  };

  const tableNode = (el: any): DocTable => {
    const rows: DocCell[][] = [];
    const total = el.getBoundingClientRect().width || 1;
    for (const tr of ownRows(el)) {
      const cells: DocCell[] = [];
      for (const td of Array.from(tr.children) as any[]) {
        if (!visible(td)) continue;
        const fill = fillOf(td) ?? fillOf(tr);
        cells.push({
          nodes: nodesFor(td, true, fill),
          shading: fill,
          borders: bordersOf(td),
          span: Math.max(1, Number(td.colSpan) || 1),
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

  /** The line someone signs on: an empty box whose only mark is its bottom border. */
  const underlineOf = (el: any): DocPara["ruleBelow"] => {
    const s = styleOf(el);
    const w = parseFloat(s.borderBottomWidth) || 0;
    if (w <= 0 || (el.textContent || "").trim()) return undefined;
    return { size: Math.max(2, Math.min(24, Math.round(w * 6))), color: hex(s.borderBottomColor) ?? "000000" };
  };

  /**
   * Is this element one line of text?
   *
   * The test that separates "a container of sections" from "a line with markup in it", and it
   * has to be geometric — inline-block, float and inline-flex all read as one or the other
   * depending only on how tall the thing came out.
   */
  const isSingleLine = (el: any): boolean => {
    const s = styleOf(el);
    const lh = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.4 || 16;
    const pad = (parseFloat(s.paddingTop) || 0) + (parseFloat(s.paddingBottom) || 0);
    return el.getBoundingClientRect().height <= lh * 1.6 + pad;
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
    // Zero-WIDTH children are kept: an empty notes column beside the totals is what holds the
    // totals over on the right, and a flex item stretches to full height even with no text.
    // Zero-HEIGHT ones are dropped — an empty `<div>{{website}}</div>` in ordinary block flow
    // shares its top with the line below it, and treating that as "side by side" put the
    // phone number in a column of its own, one digit per line.
    const boxes = kids
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((b) => b.r.height > 0)
      .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
    const rows: { el: any; r: any }[][] = [];
    let band: { top: number; bottom: number } | null = null;
    for (const b of boxes) {
      // Same row when the box overlaps the band vertically, with a couple of pixels of slack
      // for rounding and borders.
      if (band && b.r.top < band.bottom - 2) {
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
    if (tag === "TABLE") return isPageWrapper(el) ? unwrapPage(el, fill) : [tableNode(el)];
    if (tag === "IMG") {
      const img = imageNode(el);
      return img ? [img] : [];
    }
    if (tag === "BR") return [];

    const own = fillOf(el) ?? fill;
    const kids = (Array.from(el.children) as any[]).filter(visible);
    // A lone wrapper carries nothing of its own, so read the rule off the child that draws it
    // — the footer's red line lives on .page-foot, inside the cell holding it.
    const rule = ruleOf(el) ?? (kids.length === 1 ? ruleOf(kids[0]) : undefined);
    // Recurse into a container UNLESS it is a single line of text that happens to contain
    // markup. Height decides it, because the markup does not: the TOTAL bar is
    // `<span>TOTAL</span><span style="float:right">$90.14</span>` — one line, and splitting it
    // put the label and the amount on separate rows. An earlier rule asked whether every child
    // was block-level, which collapsed an entire page into one paragraph the moment a heading
    // was `display: inline-block`.
    // …but a single line whose children sit SIDE BY SIDE is still a row — SUBTOTAL and its
    // amount, or "Accepted By" beside "Accepted Date". The exception is a floated-right child,
    // which is the TOTAL bar and belongs on one line against a tab stop, not split into cells.
    const blocks = blockKidsOf(el);
    const sideBySide = blocks.length > 1 && rowsOf(blocks).some((r) => r.length > 1);
    const floatsRight = kids.some((k) => styleOf(k).float === "right");
    if (kids.length > 0 && blocks.length > 0 && (!isSingleLine(el) || (sideBySide && !floatsRight))) {
      const nested = collect(el, inCell, own);
      return rule ? [{ kind: "para", runs: [], ruleAbove: rule }, ...nested] : nested;
    }
    // A child the CSS floated right is set against a right tab stop instead of running on
    // after the label — that is what makes the TOTAL bar read across the black band.
    const floated = kids.find((k) => styleOf(k).float === "right" && (k.textContent || "").trim());
    const floatText = floated ? (floated.textContent || "").replace(/\s+/g, " ").trim() : "";
    const runs = runsOf(el, floatText);
    // A list marker is drawn by the browser, not stored in the text, so Word would print the
    // bullets as unmarked lines. One character is all these documents need.
    if (tag === "LI" && runs.length) runs[0].text = `• ${runs[0].text}`;
    const rightRuns = floated ? runsOf(floated) : [];
    const under = underlineOf(el);
    if (!runs.length && !rightRuns.length && !rule && !under) return [];
    return [
      {
        kind: "para",
        runs,
        ...(rightRuns.length ? { rightRuns } : {}),
        align: alignOf(el),
        shading: own,
        ...spacingOf(el),
        ...(rule ? { ruleAbove: rule } : {}),
        ...(under ? { ruleBelow: under } : {}),
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
      const box = root.getBoundingClientRect();
      const total = box.width || 1;
      return [
        {
          kind: "table",
          borderless: true,
          rows: rows.map((row) => {
            // A cell spans from its own left edge to the next cell's, so the gaps between
            // flex/grid items belong to a cell and the row always adds up to the full width.
            // Each box's own width would leave the remainder unaccounted for, and a zero-width
            // spacer would claim nothing at all.
            const rects = row.map((k) => k.getBoundingClientRect());
            return row.map((k, i) => {
              const right = i + 1 < rects.length ? rects[i + 1].left : box.right;
              const span = Math.max(0, right - rects[i].left);
              return {
                nodes: nodesFor(k, true, fillOf(k) ?? fill),
                shading: fillOf(k) ?? fill,
                width: Math.max(1, Math.round((span / total) * 100)),
              };
            });
          }),
        },
      ];
    }

    const out: DocNode[] = [];
    for (const el of (Array.from(root.children) as any[]).filter(visible))
      out.push(...nodesFor(el, inCell, fill));
    return out;
  }

  /** The page-layout wrapper, wherever it sits, or null for a document without one. */
  const findWrapper = (root: any): any =>
    (Array.from(root.querySelectorAll("table")) as any[]).find((t) => visible(t) && isPageWrapper(t)) ??
    null;

  const sectionNodes = (el: any, section: string): DocNode[] => {
    const out: DocNode[] = [];
    for (const tr of ownRows(el).filter((tr) => sectionOf(tr) === section))
      for (const cell of (Array.from(tr.children) as any[]).filter(visible))
        out.push(...nodesFor(cell, false, fillOf(cell)));
    return out;
  };

  const wrapper = findWrapper(doc.body);
  if (!wrapper) return { header: [], body: collect(doc.body), footer: [] };
  return {
    header: sectionNodes(wrapper, "THEAD"),
    body: sectionNodes(wrapper, "TBODY"),
    footer: sectionNodes(wrapper, "TFOOT"),
  };
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
): Promise<DocDocument> {
  return withProposalPage(html, opts, async (page) => {
    await page.setViewport({ width: 816, height: 1056 });
    const source = `(() => {
      globalThis.__name = globalThis.__name || ((fn) => fn);
      return (${extractNodes.toString()})();
    })()`;
    return (await page.evaluate(source)) as DocDocument;
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

const textRun = (r: DocRun) =>
  new TextRun({
    text: r.text,
    bold: r.bold,
    italics: r.italic,
    // docx sizes are half-points.
    size: Math.max(2, Math.round(r.size * 2)),
    ...(r.color ? { color: r.color } : {}),
    ...(r.font ? { font: r.font } : {}),
  });

function paragraph(node: DocPara, availableTwips: number): Paragraph {
  const right = node.rightRuns ?? [];
  return new Paragraph({
    ...(node.align ? { alignment: ALIGN[node.align] } : {}),
    ...(node.shading ? { shading: { fill: node.shading } } : {}),
    ...(node.ruleAbove || node.ruleBelow
      ? {
          border: {
            ...(node.ruleAbove
              ? { top: { style: BorderStyle.SINGLE, size: node.ruleAbove.size, color: node.ruleAbove.color } }
              : {}),
            ...(node.ruleBelow
              ? { bottom: { style: BorderStyle.SINGLE, size: node.ruleBelow.size, color: node.ruleBelow.color } }
              : {}),
          },
        }
      : {}),
    // A right tab stop at the text edge is how Word pushes a figure to the margin.
    ...(right.length
      ? { tabStops: [{ type: TabStopType.RIGHT, position: Math.max(720, availableTwips - 120) }] }
      : {}),
    // A shaded paragraph's fill extends through its own trailing space, so the gap between
    // two black panels would be black too. The space is emitted as an unshaded spacer
    // paragraph instead (see docxFromNodes), and the panel itself ends where its text does.
    spacing: {
      before: node.spaceBefore ?? 20,
      after: node.shading ? 0 : node.spaceAfter ?? 20,
    },
    children: [
      ...node.runs.map(textRun),
      ...(right.length
        ? [new TextRun({ children: [new Tab()] }), ...right.map(textRun)]
        : []),
    ],
  });
}

const edgeOf = (e?: DocEdge) =>
  e ? { style: BorderStyle.SINGLE, size: e.size, color: e.color } : NO_BORDER;

/**
 * Usable width of a Letter page inside the section margins below, in twips.
 *
 * Widths are absolute, NOT percentages. OOXML's `w:type="pct"` counts in FIFTIETHS of a
 * percent, so a cell written as 18% is read as 0.36% of the table — under AUTOFIT Word
 * quietly re-flowed by content and hid it, and the moment the layout was FIXED every column
 * collapsed to a single character. Twips have one meaning.
 */
const PAGE_MARGIN = { top: 1440, right: 1080, bottom: 1080, left: 1080, header: 480, footer: 480 };
const CONTENT_TWIPS = 12240 - PAGE_MARGIN.left - PAGE_MARGIN.right;

function table(node: DocTable, availableTwips: number): Table {
  const widthOf = (pct?: number) =>
    Math.max(240, Math.round(((pct ?? 100) / 100) * availableTwips));

  // THE GRID IS WHAT ACTUALLY SIZES A FIXED-LAYOUT TABLE. Per-cell widths alone leave
  // `<w:tblGrid>` filled with the library's placeholder columns, all equal, and Word and
  // LibreOffice both size from the grid and ignore the cells — which squeezed DESCRIPTION
  // until it wrapped while the numeric columns sat half empty.
  // The grid comes from a row with no spans — that is the one stating every column.
  const columnsIn = (row: DocCell[]) => row.reduce((n, c) => n + (c.span ?? 1), 0);
  const widest = node.rows.reduce((a, r) => (r.length > a.length ? r : a), node.rows[0] ?? []);
  const columnWidths = widest.map((c) => widthOf(c.width));
  // Ragged rows have no single grid; let Word lay those out rather than mis-state one. A row
  // that SPANS is not ragged — it covers the same columns with fewer cells.
  const columns = columnsIn(widest);
  const uniform = node.rows.every((r) => columnsIn(r) === columns) && columnWidths.length > 0;

  return new Table({
    width: { size: availableTwips, type: WidthType.DXA },
    ...(uniform ? { columnWidths } : {}),
    // FIXED honours the measured column widths. Left to AUTOFIT, Word re-flows them by its
    // own content rules and narrow numeric columns wrap ("1 bulb" onto two lines).
    layout: uniform ? TableLayoutType.FIXED : TableLayoutType.AUTOFIT,
    // Edges are a property of the cells the CSS drew them on; the table itself never adds
    // Word's default grid on top.
    borders: NO_BORDERS,
    rows: node.rows.map(
      (row) =>
        new TableRow({
          children: row.map((c) => {
            const twips = widthOf(c.width);
            return new TableCell({
              width: { size: twips, type: WidthType.DXA },
              ...((c.span ?? 1) > 1 ? { columnSpan: c.span } : {}),
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
              // A nested table measures against THIS cell, not the page, or it overflows.
              children: docxFromNodes(c.nodes, true, twips - 80) as (Paragraph | Table)[],
            });
          }),
        })
    ),
  });
}

/**
 * Nodes → docx elements. Pure, so the shape of a converted document is asserted without a
 * browser (scripts/check-html-template.ts).
 */
export function docxFromNodes(
  nodes: DocNode[],
  inCell = false,
  availableTwips: number = CONTENT_TWIPS
): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  for (const node of nodes) {
    if (node.kind === "para") {
      out.push(paragraph(node, availableTwips));
      // The unshaded gap after a filled block, at exactly the height the CSS margin asked
      // for — this is what keeps the two estimate panels apart, and the blank panel off the
      // table header.
      if (node.shading && node.spaceAfter)
        out.push(
          new Paragraph({
            spacing: { before: 0, after: 0, line: node.spaceAfter, lineRule: LineRuleType.EXACT },
            children: [new TextRun({ text: "", size: 2 })],
          })
        );
    } else if (node.kind === "table") out.push(table(node, availableTwips));
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

/**
 * The whole document, ready for `new Document({ sections })`.
 *
 * The letterhead and footer go into Word's own header/footer parts, which it repeats on every
 * page — the page margins leave the room for them.
 */
export function docxSection(doc: DocDocument): ISectionOptions {
  const head = docxFromNodes(doc.header);
  const foot = docxFromNodes(doc.footer);
  return {
    // One source for the margins, so the table widths above cannot drift from the page.
    properties: { page: { margin: PAGE_MARGIN } },
    ...(head.length ? { headers: { default: new Header({ children: head }) } } : {}),
    ...(foot.length ? { footers: { default: new Footer({ children: foot }) } } : {}),
    children: docxFromNodes(doc.body),
  };
}
