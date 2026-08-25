import PizZip from "pizzip";
import { getDocument } from "pdfjs-dist/legacy/build/pdf";
import {
  DYNAMIC_BLOCK_TYPES,
  type BlockStyle,
  type DynamicBlockType,
  type ProposalBlock,
  type StaticFormat,
  type StaticPart,
} from "./proposalTemplate";

// NOTE: this module must stay free of any import that reaches estimateService or lib/prisma —
// both construct a client at module load and throw without credentials, and
// check-proposal-import.ts runs inside the Docker build where there are none. The LLM half
// lives in proposalImportClassify.ts for exactly that reason.

/**
 * Turn a company's existing proposal document into an editable ProposalBlock[].
 *
 * Two stages, deliberately separated:
 *  1. EXTRACT — read the file into flat paragraphs carrying whatever formatting the format
 *     actually exposes. .docx is parsed from its own XML, so alignment/bold/italic/font/size
 *     are read, not guessed. PDF has no paragraph structure at all, so formatting is inferred
 *     from text position and the embedded font name, and `formattingInferred` is set so the
 *     admin can be told rather than left to discover it.
 *  2. CLASSIFY — an LLM decides which paragraphs are the company's own boilerplate (static)
 *     and which are placeholders for quote data (dynamic: line items, totals, customer block,
 *     photos, letterhead). This is the step that cannot be done by parsing: only meaning
 *     distinguishes "our standard exclusions" from "the table where prices go".
 *
 * The result always lands in the admin editor for review before it is saved, so an imperfect
 * import is a starting point, never a silent misconfiguration.
 */

/** One paragraph as extracted from the source file, before any classification. */
export interface ExtractedParagraph {
  text: string;
  style: BlockStyle;
  /** Set when the source marked this paragraph as a list item. */
  list?: "bullets" | "numbered";
}

export interface ExtractResult {
  paragraphs: ExtractedParagraph[];
  /** True for PDF: formatting was inferred from layout, not read from the document. */
  formattingInferred: boolean;
}

export class ProposalImportError extends Error {}

// ------------------------------------------------------------------ .docx extraction

const xmlText = (fragment: string): string =>
  fragment
    // <w:t> holds the visible text; everything else in a run is metadata.
    .match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)
    ?.map((t) => t.replace(/<[^>]+>/g, ""))
    .join("")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'") ?? "";

const DOCX_ALIGN: Record<string, BlockStyle["align"]> = {
  left: "left",
  start: "left",
  center: "center",
  right: "right",
  end: "right",
};

/**
 * numId → list kind, resolved through numbering.xml's numId → abstractNumId → numFmt chain.
 * Anything that is not an explicit bullet format counts as numbered (decimal, lowerLetter,
 * upperRoman … all render as an ordered list in the block model's two formats).
 */
function numberingFormats(numberingXml: string): Map<string, "bullets" | "numbered"> {
  const out = new Map<string, "bullets" | "numbered">();
  if (!numberingXml) return out;
  const abstractFormat = new Map<string, "bullets" | "numbered">();
  for (const block of numberingXml.match(/<w:abstractNum\b[\s\S]*?<\/w:abstractNum>/g) ?? []) {
    const id = block.match(/w:abstractNumId="(\d+)"/)?.[1];
    if (!id) continue;
    // The level-0 format is the one the block model can express.
    const fmt = block.match(/<w:numFmt\s+w:val="(\w+)"/)?.[1] ?? "";
    abstractFormat.set(id, fmt.toLowerCase() === "bullet" ? "bullets" : "numbered");
  }
  for (const block of numberingXml.match(/<w:num\b[^>]*>[\s\S]*?<\/w:num>/g) ?? []) {
    const numId = block.match(/w:numId="(\d+)"/)?.[1];
    const abstractId = block.match(/<w:abstractNumId\s+w:val="(\d+)"/)?.[1];
    if (numId && abstractId && abstractFormat.has(abstractId))
      out.set(numId, abstractFormat.get(abstractId)!);
  }
  return out;
}

/**
 * Read paragraphs and their formatting out of word/document.xml.
 *
 * ponytail: regex over the paragraph XML rather than a full OOXML parse. It reads what the
 * block model can express — alignment, bold, italic, font, size, colour, list kind — and
 * ignores what the model cannot render in both formats anyway (tables, text boxes, headers,
 * footers, styles inherited from styles.xml). A document whose formatting lives entirely in
 * named styles will import with default formatting; the editor is where that gets fixed.
 */
export function extractDocxParagraphs(buffer: Buffer): ExtractResult {
  let documentXml: string;
  let numberingXml = "";
  try {
    const zip = new PizZip(buffer);
    const entry = zip.file("word/document.xml");
    if (!entry) throw new Error("no word/document.xml");
    documentXml = entry.asText();
    // Optional: absent in a document with no lists.
    numberingXml = zip.file("word/numbering.xml")?.asText() ?? "";
  } catch (err) {
    throw new ProposalImportError(
      `Not a readable .docx file: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const listFormats = numberingFormats(numberingXml);
  const paragraphs: ExtractedParagraph[] = [];
  for (const para of documentXml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? []) {
    const text = xmlText(para).trim();
    if (!text) continue;

    const props = para.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
    // Formatting is taken from the FIRST run: the model styles a whole block, so a paragraph
    // with mixed runs is normalised to its opening run rather than losing the block model.
    const firstRunProps = para.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] ?? "";

    const style: BlockStyle = {};
    const align = props.match(/<w:jc\s+w:val="(\w+)"/)?.[1];
    if (align && DOCX_ALIGN[align]) style.align = DOCX_ALIGN[align];
    // <w:b/> means on; <w:b w:val="0"/> means explicitly off.
    if (/<w:b(?:\s+w:val="(?:1|true|on)")?\s*\/>/.test(firstRunProps)) style.bold = true;
    if (/<w:i(?:\s+w:val="(?:1|true|on)")?\s*\/>/.test(firstRunProps)) style.italic = true;
    const font = firstRunProps.match(/<w:rFonts[^>]*w:ascii="([^"]+)"/)?.[1];
    if (font) style.fontFamily = font;
    const halfPoints = firstRunProps.match(/<w:sz\s+w:val="(\d+)"/)?.[1];
    if (halfPoints) style.fontSize = Math.round(Number(halfPoints) / 2);
    const color = firstRunProps.match(/<w:color\s+w:val="([0-9A-Fa-f]{6})"/)?.[1];
    if (color && color.toUpperCase() !== "000000") style.color = color.toUpperCase();

    // Word stores list membership as a numbering reference and the marker itself in
    // numbering.xml — a numbered item's text contains no digit, so the format has to be
    // resolved through numId → abstractNum → numFmt or every numbered list imports as bullets.
    const numId = props.match(/<w:numId\s+w:val="(\d+)"/)?.[1];
    const list = /<w:numPr>/.test(props)
      ? (numId && listFormats.get(numId)) ?? (/^\d+[.)]/.test(text) ? "numbered" : "bullets")
      : undefined;

    paragraphs.push({ text: text.replace(/^\d+[.)]\s*/, ""), style, ...(list ? { list } : {}) });
  }

  if (paragraphs.length === 0)
    throw new ProposalImportError("No text could be read from this .docx file");
  return { paragraphs, formattingInferred: false };
}

// ------------------------------------------------------------------ PDF extraction

const PAGE_CENTER_TOLERANCE = 40;

/**
 * PDF has no paragraphs — only positioned glyph runs. Lines are rebuilt by y-position (the
 * same grouping the pricebook ingest uses), then formatting is INFERRED: bold from the
 * embedded font name, size from the glyph height, alignment from where the line sits relative
 * to the page centre. Consecutive lines are joined into a paragraph on a blank-line gap.
 */
export async function extractPdfParagraphs(buffer: Buffer): Promise<ExtractResult> {
  let doc;
  try {
    doc = await getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
  } catch (err) {
    throw new ProposalImportError(
      `Not a readable PDF: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  interface Line {
    text: string;
    x: number;
    right: number;
    size: number;
    bold: boolean;
    italic: boolean;
    font?: string;
    gapAbove: number;
  }
  const lines: Line[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const pageWidth = page.getViewport({ scale: 1 }).width;
    const content = await page.getTextContent();
    const byY = new Map<number, { x: number; str: string; w: number; h: number; font?: string }[]>();
    for (const item of content.items as {
      str?: string;
      transform?: number[];
      width?: number;
      height?: number;
      fontName?: string;
    }[]) {
      if (typeof item.str !== "string" || !item.str.trim() || !item.transform) continue;
      const y = Math.round(item.transform[5]);
      const list = byY.get(y) ?? [];
      list.push({
        x: item.transform[4],
        str: item.str,
        w: item.width ?? 0,
        h: item.height ?? 0,
        font: item.fontName,
      });
      byY.set(y, list);
    }
    const ys = [...byY.keys()].sort((a, b) => b - a);
    ys.forEach((y, i) => {
      const items = byY.get(y)!.sort((a, b) => a.x - b.x);
      const text = items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
      if (!text) return;
      const fontName = items[0].font ?? "";
      const size = Math.round(Math.max(...items.map((it) => it.h)) || 10);
      const left = items[0].x;
      const right = items[items.length - 1].x + items[items.length - 1].w;
      lines.push({
        text,
        x: left,
        right,
        size,
        // pdfjs font names carry the weight, e.g. "g_d0_f2" is opaque but embedded names are
        // usually like "ABCDEE+Calibri-Bold". Only trust an explicit Bold/Italic marker.
        bold: /bold/i.test(fontName),
        italic: /italic|oblique/i.test(fontName),
        font: fontName.replace(/^[A-Z]{6}\+/, "").split(/[-,]/)[0] || undefined,
        gapAbove: i === 0 ? 0 : Math.abs(ys[i - 1] - y),
      });
    });

    // Alignment is judged per page, since it depends on that page's width.
    for (const line of lines.slice(-ys.length)) {
      const mid = (line.x + line.right) / 2;
      if (Math.abs(mid - pageWidth / 2) < PAGE_CENTER_TOLERANCE) (line as Line & { align?: string }).align = "center";
    }
  }

  if (lines.length === 0)
    throw new ProposalImportError(
      "No text could be extracted from this PDF — it may be a scan. Upload a .docx, or a PDF with real text."
    );

  // A line starting a new paragraph is one preceded by a gap noticeably larger than the
  // body's own line spacing.
  const typicalGap =
    [...lines.map((l) => l.gapAbove).filter((g) => g > 0)].sort((a, b) => a - b)[
      Math.floor(lines.filter((l) => l.gapAbove > 0).length / 2)
    ] ?? 12;

  const paragraphs: ExtractedParagraph[] = [];
  for (const line of lines) {
    const style: BlockStyle = { fontSize: line.size };
    if (line.bold) style.bold = true;
    if (line.italic) style.italic = true;
    if (line.font) style.fontFamily = line.font;
    const align = (line as Line & { align?: BlockStyle["align"] }).align;
    if (align) style.align = align;
    const bulletMatch = line.text.match(/^\s*(?:[•·▪◦-]|\d+[.)])\s+(.*)$/);
    const text = (bulletMatch?.[1] ?? line.text).trim();
    if (!text) continue;

    const isNewParagraph =
      paragraphs.length === 0 || !!bulletMatch || line.gapAbove > typicalGap * 1.6;
    const prev = paragraphs[paragraphs.length - 1];
    if (!isNewParagraph && prev && !prev.list) {
      prev.text = `${prev.text} ${text}`.trim();
      continue;
    }
    paragraphs.push({
      text,
      style,
      ...(bulletMatch ? { list: /^\s*\d+[.)]/.test(line.text) ? "numbered" as const : "bullets" as const } : {}),
    });
  }

  return { paragraphs, formattingInferred: true };
}


// ------------------------------------------------------------------ block assembly

/** The classifier's raw output shape: static blocks reference paragraphs by index. */
export interface ClassifiedBlock {
  heading: string | null;
  dynamic: string | null;
  paragraphIndexes: number[];
}

/** Case/punctuation-insensitive comparison for "is this paragraph just the heading again". */
const normalizeHeading = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Rebuild ProposalBlocks from classified paragraph indexes. Pure and separate from the LLM
 * call so the Docker-build check can pin its rules, the load-bearing one being: static text
 * comes from the EXTRACTED paragraphs verbatim, never from the model retyping it.
 *
 * The classifier tends to include a section's heading paragraph in the section's own indexes
 * even when told not to — which printed every heading twice (once as the block heading, once
 * as body text; bug report 2026-08-24). The first content paragraph that is texturally just
 * the heading again is therefore dropped here, deterministically.
 */
export function assembleImportedBlocks(
  paragraphs: ExtractedParagraph[],
  classified: ClassifiedBlock[]
): ProposalBlock[] {
  const used = new Set<number>();
  const blocks: ProposalBlock[] = [];
  let n = 0;

  for (const b of classified) {
    const heading = b.heading?.trim() || undefined;
    if (b.dynamic && DYNAMIC_BLOCK_TYPES.includes(b.dynamic as DynamicBlockType)) {
      blocks.push({
        id: `${b.dynamic}-${++n}`,
        visible: true,
        ...(heading ? { heading } : {}),
        dynamic: b.dynamic as DynamicBlockType,
      });
      continue;
    }
    const parts: StaticPart[] = [];
    let headingDropped = false;
    for (const idx of b.paragraphIndexes ?? []) {
      const para = paragraphs[idx];
      if (!para || used.has(idx)) continue;
      used.add(idx);
      // The heading paragraph itself, re-listed as content: skip ONE such paragraph, only
      // while the block has no body yet — a later deliberate repetition of the words stays.
      if (
        heading &&
        !headingDropped &&
        parts.length === 0 &&
        !para.list &&
        normalizeHeading(para.text) === normalizeHeading(heading)
      ) {
        headingDropped = true;
        continue;
      }
      const format: StaticFormat = para.list ?? "paragraph";
      const last = parts[parts.length - 1];
      if (last && format !== "paragraph" && last.format === format) last.items!.push(para.text);
      else if (format === "paragraph") parts.push({ format, text: para.text, style: para.style });
      else parts.push({ format, items: [para.text], style: para.style });
    }
    if (parts.length === 0) continue;
    blocks.push({
      id: `section-${++n}`,
      visible: true,
      ...(heading ? { heading } : {}),
      content: parts,
    });
  }
  // Extraction cannot read a logo or photos out of a .docx or PDF, so an imported template
  // would silently lose the letterhead and the job-photos section — every import starts with
  // the logo block and ends with the photos block unless the classifier already placed them.
  // Photos render nothing when a quote has none, and the admin can hide or delete either.
  if (!blocks.some((b) => b.dynamic === "logo"))
    blocks.unshift({ id: "logo", visible: true, dynamic: "logo", style: { align: "left" } });
  if (!blocks.some((b) => b.dynamic === "photos"))
    blocks.push({ id: "photos", heading: "Project Photos", visible: true, dynamic: "photos" });
  return blocks;
}
