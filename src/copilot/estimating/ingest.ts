import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
// The legacy CJS build works in Node without a worker or canvas for text-only extraction.
import { getDocument } from "pdfjs-dist/legacy/build/pdf";
import logger from "../../lib/logger";

/**
 * Pricebook file ingestion (pricebook-config PRD US2): CSV, Excel, or PDF in, validated
 * rows out. Validation is deliberately minimal per the PRD — an item identifier must be
 * present and the price must be numeric; a row/entry failing either is skipped and logged,
 * never aborting the rest of the file. PDF sources are expected to skip more (their layout
 * is rarely clean rows); that is an accepted v1 trade-off, not a defect.
 */

export interface ParsedRow {
  code: string | null;
  description: string;
  unit: string | null;
  unitPrice: number;
}

export interface SkippedRow {
  line: number;
  reason: string;
}

export interface IngestParse {
  format: "csv" | "excel" | "pdf";
  rows: ParsedRow[];
  skipped: SkippedRow[];
}

/** Thrown when the FILE as a whole is unusable (vs. individual rows, which are skipped). */
export class IngestError extends Error {}

const HEADER_ALIASES = {
  code: ["code", "sku", "itemcode", "itemnumber", "itemno", "item#", "partnumber", "partno", "productcode"],
  description: ["description", "desc", "item", "itemname", "name", "product", "productname", "material", "itemdescription"],
  price: ["price", "unitprice", "cost", "unitcost", "rate", "sellprice", "listprice", "saleprice"],
  unit: ["unit", "uom", "unitofmeasure", "units", "measure"],
} as const;

const normalizeHeader = (v: string) => v.toLowerCase().replace(/[^a-z0-9#]/g, "");

function detectColumns(header: string[]): { code: number; description: number; price: number; unit: number } | null {
  const find = (aliases: readonly string[]) =>
    header.findIndex((h) => aliases.includes(normalizeHeader(h)));
  const description = find(HEADER_ALIASES.description);
  const price = find(HEADER_ALIASES.price);
  if (description < 0 || price < 0) return null;
  return { code: find(HEADER_ALIASES.code), description, price, unit: find(HEADER_ALIASES.unit) };
}

/** "$1,234.50" → 1234.5; anything non-numeric → null. */
function parsePrice(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Validate one tabular row against the PRD's two checks. */
function validateRow(
  cells: { code: string; description: string; unit: string; price: string },
  line: number
): { row?: ParsedRow; skip?: SkippedRow } {
  const description = cells.description.trim();
  if (!description) return { skip: { line, reason: "missing item identifier" } };
  const unitPrice = parsePrice(cells.price);
  if (unitPrice == null)
    return { skip: { line, reason: `price is not numeric ("${cells.price.trim() || "(empty)"}")` } };
  return {
    row: {
      code: cells.code.trim() || null,
      description,
      unit: cells.unit.trim() || null,
      unitPrice,
    },
  };
}

function parseCsvBuffer(buffer: Buffer): IngestParse {
  let records: string[][];
  try {
    records = parseCsv(buffer, {
      relax_column_count: true,
      skip_empty_lines: true,
      bom: true,
      trim: true,
    }) as string[][];
  } catch (err) {
    throw new IngestError(`Not a parseable CSV file: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (records.length === 0) throw new IngestError("The file is empty");
  const cols = detectColumns(records[0]);
  if (!cols)
    throw new IngestError(
      "Could not find the required columns — the header row must name an item/description column and a price column"
    );
  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  records.slice(1).forEach((record, i) => {
    const cell = (idx: number) => (idx >= 0 ? String(record[idx] ?? "") : "");
    const result = validateRow(
      { code: cell(cols.code), description: cell(cols.description), unit: cell(cols.unit), price: cell(cols.price) },
      i + 2 // 1-based, after the header
    );
    if (result.row) rows.push(result.row);
    else if (result.skip) skipped.push(result.skip);
  });
  return { format: "csv", rows, skipped };
}

/** Excel cells can hold rich text, formula results, dates — reduce each to display text. */
function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((r) => r.text).join("");
    if ("result" in value) return value.result == null ? "" : String(value.result);
    if ("text" in value) return String(value.text);
    return String(value);
  }
  return String(value);
}

async function parseExcelBuffer(buffer: Buffer): Promise<IngestParse> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch (err) {
    throw new IngestError(
      `Not a parseable Excel (.xlsx) file: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new IngestError("The workbook has no worksheets");

  const grid: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cellText(cell.value);
    });
    grid[rowNumber - 1] = cells;
  });
  const compact = grid.map((r, i) => ({ cells: r ?? [], line: i + 1 })).filter((r) => r.cells.some((c) => c?.trim()));
  if (compact.length === 0) throw new IngestError("The worksheet is empty");
  const cols = detectColumns(compact[0].cells.map((c) => c ?? ""));
  if (!cols)
    throw new IngestError(
      "Could not find the required columns — the first row must name an item/description column and a price column"
    );
  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  for (const { cells, line } of compact.slice(1)) {
    const cell = (idx: number) => (idx >= 0 ? (cells[idx] ?? "") : "");
    const result = validateRow(
      { code: cell(cols.code), description: cell(cols.description), unit: cell(cols.unit), price: cell(cols.price) },
      line
    );
    if (result.row) rows.push(result.row);
    else if (result.skip) skipped.push(result.skip);
  }
  return { format: "excel", rows, skipped };
}

/**
 * PDF: extract text, then treat each line ending in a money-like number as "identifier ...
 * price". Deliberately naive — real pricebook PDFs vary wildly in layout, and the PRD accepts
 * a high, variable skip rate for PDF in v1. Lines with no trailing number are dropped
 * silently (headings, prose); lines that LOOK like entries but fail validation are counted.
 * ponytail: regex line extraction; upgrade path is LLM extraction at upload time if real
 * client PDFs skip too much.
 */
const PDF_LINE_RE = /^(.*?[a-zA-Z].*?)[\s.]{1,}\$?\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,4})?)\s*$/;

/** Extract the PDF's text, rebuilding lines by grouping items on their y position. */
async function pdfText(buffer: Buffer): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const byY = new Map<number, { x: number; str: string }[]>();
    for (const item of content.items as { str?: string; transform?: number[] }[]) {
      if (typeof item.str !== "string" || !item.str.trim() || !item.transform) continue;
      const y = Math.round(item.transform[5]);
      const list = byY.get(y) ?? [];
      list.push({ x: item.transform[4], str: item.str });
      byY.set(y, list);
    }
    for (const y of [...byY.keys()].sort((a, b) => b - a)) {
      lines.push(
        byY
          .get(y)!
          .sort((a, b) => a.x - b.x)
          .map((i) => i.str)
          .join(" ")
      );
    }
  }
  return lines.join("\n");
}

async function parsePdfBuffer(buffer: Buffer): Promise<IngestParse> {
  let text: string;
  try {
    text = await pdfText(buffer);
  } catch (err) {
    throw new IngestError(`Not a parseable PDF: ${err instanceof Error ? err.message : String(err)}`);
  }
  const lines = text.split(/\r?\n/);
  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const m = trimmed.match(PDF_LINE_RE);
    if (!m) return; // heading/prose, not an entry-shaped line
    const description = m[1].replace(/[\s.·]+$/, "").trim();
    const unitPrice = parsePrice(m[2]);
    if (description.length < 3) {
      skipped.push({ line: i + 1, reason: "missing item identifier" });
      return;
    }
    if (unitPrice == null) {
      skipped.push({ line: i + 1, reason: `price is not numeric ("${m[2]}")` });
      return;
    }
    // A leading catalog-code token ("SP-001 Sprinkler head ...") becomes the code.
    const codeMatch = description.match(/^([A-Z0-9][A-Z0-9-]{1,19})\s{1,}(.{3,})$/);
    rows.push({
      code: codeMatch ? codeMatch[1] : null,
      description: codeMatch ? codeMatch[2].trim() : description,
      unit: null,
      unitPrice,
    });
  });
  if (rows.length === 0 && skipped.length === 0)
    throw new IngestError(
      "No price entries could be extracted from this PDF — its layout may not be line-based. Convert it to CSV/Excel and re-upload."
    );
  return { format: "pdf", rows, skipped };
}

export async function parsePricebookFile(buffer: Buffer, filename: string): Promise<IngestParse> {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  let parsed: IngestParse;
  if (ext === "csv" || ext === "txt") parsed = parseCsvBuffer(buffer);
  else if (ext === "xlsx" || ext === "xls") parsed = await parseExcelBuffer(buffer);
  else if (ext === "pdf") parsed = await parsePdfBuffer(buffer);
  else throw new IngestError(`Unsupported file type ".${ext}" — upload a CSV, Excel (.xlsx), or PDF pricebook`);

  for (const skip of parsed.skipped)
    logger.warn("Pricebook ingestion skipped a row", { filename, ...skip });
  logger.info("Pricebook file parsed", {
    filename,
    format: parsed.format,
    rows: parsed.rows.length,
    skipped: parsed.skipped.length,
  });
  return parsed;
}
