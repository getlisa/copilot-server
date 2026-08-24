/**
 * Regression check for pricebook file ingestion (pricebook-config PRD US2): the two-part
 * validation rule (identifier present + numeric price), skip-and-log without aborting the
 * file, header detection, and all three formats — the Excel and PDF fixtures are generated
 * in-memory with the same libraries the server ships.
 *
 * Pure — no network, no database.
 *   npx tsx scripts/check-ingest.ts
 */
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { parsePricebookFile, IngestError } from "../src/copilot/estimating/ingest";

let failures = 0;
const expect = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else console.log(`ok   ${label}`);
};

async function main() {
  // --- Excel: the catalog split across sheets, with title rows above the headers ---
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet("Sprinklers");
  s1.addRow(["ACME SUPPLY — 2026 PRICE LIST"]); // title row above the header
  s1.addRow([]);
  s1.addRow(["Item Number", "Description", "UOM", "Unit Price"]);
  s1.addRow(["SP-001", "Sprinkler head, pendent", "EA", 5.25]);
  const s2 = wb.addWorksheet("Fittings");
  // Different column ORDER on this tab — each sheet detects its own header.
  s2.addRow(["Description", "Price", "SKU"]);
  s2.addRow(["1/2 in EMT coupling", 0.89, "FIT-100"]);
  s2.addRow(["", 9.99, "FIT-BAD"]); // skipped: no identifier
  wb.addWorksheet("Notes").addRow(["Just prose, no table here"]); // skipped sheet, visibly
  wb.addWorksheet("Blank"); // empty tab: ignored, not an error
  const multiSheet = await parsePricebookFile(
    Buffer.from(await wb.xlsx.writeBuffer()),
    "multi.xlsx"
  );
  expect("xlsx: rows gathered from EVERY sheet", multiSheet.rows.length, 2);
  expect(
    "xlsx: each sheet's own header/column order respected",
    multiSheet.rows.map((r) => r.code),
    ["SP-001", "FIT-100"]
  );
  expect(
    "xlsx: a header below title rows is still found",
    multiSheet.rows[0].description,
    "Sprinkler head, pendent"
  );
  expect(
    "xlsx: a no-table sheet is skipped with a visible reason",
    multiSheet.skipped.some((k) => k.sheet === "Notes" && k.reason.includes("sheet skipped")),
    true
  );
  expect(
    "xlsx: row skips name their sheet",
    multiSheet.skipped.some((k) => k.sheet === "Fittings" && k.reason === "missing item identifier"),
    true
  );

  // --- the distributor-sheet shape that silently broke (bug 2026-08-24) ---
  // "Item" holds part numbers, "Description" holds the words. Leftmost-any-alias matching
  // ingested the part numbers as descriptions; alias PRIORITY must pick Description.
  const wb2 = new ExcelJS.Workbook();
  const dist = wb2.addWorksheet("Net Pricing");
  dist.addRow(["Item", "Description", "UOM", "Net Price"]);
  dist.addRow(["VSRF0100", "FLOW SWITCH RETARD 1-2IN", "EA", 475.02]);
  dist.addRow(["V5097P", "ONE STOP SOLVENT CEMENT PINT", "EA", 54.58]);
  const distParsed = await parsePricebookFile(Buffer.from(await wb2.xlsx.writeBuffer()), "net_pricing.xlsx");
  expect("distributor sheet: words become the description", distParsed.rows[0].description, "FLOW SWITCH RETARD 1-2IN");
  expect("distributor sheet: the part number becomes the code", distParsed.rows[0].code, "VSRF0100");
  expect(
    "the chosen mapping is reported for the admin to see",
    distParsed.columns,
    { code: "Item", description: "Description", price: "Net Price", unit: "UOM" }
  );

  // A sheet with ONLY an Item column still ingests: Item is the identifier of last resort.
  const wb3 = new ExcelJS.Workbook();
  const bare = wb3.addWorksheet("Bare");
  bare.addRow(["Item", "Price"]);
  bare.addRow(["Widget thing", 9.99]);
  const bareParsed = await parsePricebookFile(Buffer.from(await wb3.xlsx.writeBuffer()), "bare.xlsx");
  expect("item-only sheet: Item is the description", bareParsed.rows[0].description, "Widget thing");
  expect("item-only sheet: no code column is claimed", bareParsed.rows[0].code, null);

  // Legacy .xls: rejected with instructions, not a baffling parse error.
  let xlsError = "";
  try {
    await parsePricebookFile(Buffer.from("junk"), "legacy.xls");
  } catch (err) {
    xlsError = err instanceof IngestError ? (err as Error).message : "other";
  }
  expect("xls: rejected with a save-as-xlsx instruction", xlsError.includes("save as .xlsx"), true);

  // --- CSV ---
  const csv = Buffer.from(
    [
      "Item Number,Description,UOM,Unit Price",
      'SP-001,"Sprinkler head, pendent",EA,$5.25',
      "SP-00X,,EA,9.99", // skipped: no item identifier (description is the identifier)
      "SP-002,Bad price row,EA,call for pricing", // skipped: non-numeric price
      "SP-003,Escutcheon plate,EA,1.10",
    ].join("\n")
  );
  const fromCsv = await parsePricebookFile(csv, "book.csv");
  expect("csv: valid rows ingested", fromCsv.rows.length, 2);
  expect("csv: invalid rows skipped, not fatal", fromCsv.skipped.length, 2);
  expect("csv: price parsed from $-format", fromCsv.rows[0].unitPrice, 5.25);
  expect("csv: code column captured", fromCsv.rows[0].code, "SP-001");
  expect(
    "csv: skip reasons name the failure",
    fromCsv.skipped.map((s) => s.reason.split(' ("')[0]),
    ["missing item identifier", "price is not numeric"]
  );

  // Header without the required columns → the FILE is rejected, not silently empty.
  let headerError = "";
  try {
    await parsePricebookFile(Buffer.from("a,b\n1,2"), "bad.csv");
  } catch (err) {
    headerError = err instanceof IngestError ? "IngestError" : "other";
  }
  expect("csv: unusable header rejects the file", headerError, "IngestError");

  // --- Excel ---
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Pricebook");
  sheet.addRow(["SKU", "Item Name", "Unit", "Cost"]);
  sheet.addRow(["EL-100", "20A single pole breaker", "EA", 8.5]);
  sheet.addRow(["EL-101", "No price here", "EA", "TBD"]); // skipped
  sheet.addRow(["EL-102", "12 AWG THHN wire", "ft", 0.45]);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const fromXlsx = await parsePricebookFile(xlsx, "book.xlsx");
  expect("excel: valid rows ingested", fromXlsx.rows.length, 2);
  expect("excel: invalid rows skipped", fromXlsx.skipped.length, 1);
  expect("excel: numeric cell read", fromXlsx.rows[0].unitPrice, 8.5);
  expect("excel: unit column captured", fromXlsx.rows[1].unit, "ft");

  // --- PDF ---
  const pdfBuffer: Buffer = await new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.text("ACME FIRE PROTECTION PRICE LIST"); // heading — silently ignored
    doc.text("SP-001  Pendent sprinkler head   $5.25");
    doc.text("SP-002  Sidewall sprinkler head  7.80");
    doc.text("Terms and conditions apply to all orders"); // prose, no trailing number
    doc.end();
  });
  const fromPdf = await parsePricebookFile(pdfBuffer, "book.pdf");
  expect("pdf: entry-shaped lines ingested", fromPdf.rows.length, 2);
  expect("pdf: prices extracted", fromPdf.rows.map((r) => r.unitPrice), [5.25, 7.8]);
  expect("pdf: leading catalog code split out", fromPdf.rows[0].code, "SP-001");

  // Unsupported extension → rejected up front.
  let extError = "";
  try {
    await parsePricebookFile(Buffer.from("x"), "book.docx");
  } catch (err) {
    extError = err instanceof IngestError ? "IngestError" : "other";
  }
  expect("unsupported extension rejected", extError, "IngestError");

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll ingest checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
