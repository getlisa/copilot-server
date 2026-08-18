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
