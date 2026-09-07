/**
 * Regression check for uploaded .docx quote templates: placeholder fill, line-item loops,
 * blank rendering for unconfigured fields, and upload-time rejection of broken tags.
 * The fixture template is generated with the same `docx` library the server ships.
 *
 * Pure — no network, no database, no S3.
 *   npx tsx scripts/check-template.ts
 */
import { Document, Packer, Paragraph, TextRun } from "docx";
import PizZip from "pizzip";
import {
  templateData,
  validateDocxTemplate,
  type InvoiceBranding,
} from "../src/copilot/estimating/templates";
import Docxtemplater from "docxtemplater";
import type { QuoteDto } from "../src/copilot/estimating/quoteDto";

let failures = 0;
const expect = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else console.log(`ok   ${label}`);
};

const docxWith = (lines: string[]): Promise<Buffer> =>
  Packer.toBuffer(
    new Document({
      sections: [{ children: lines.map((t) => new Paragraph({ children: [new TextRun(t)] })) }],
    })
  );

const extractText = (buffer: Buffer): string =>
  new PizZip(buffer)
    .file("word/document.xml")!
    .asText()
    .replace(/<[^>]+>/g, "");

async function main() {
  const template = await docxWith([
    "QUOTE from {companyName} {website}",
    "{#lineItems}{description}: {quantity} {unit} @ {unitPrice} = {totalPrice}",
    "{/lineItems}",
    "Total: {total}",
    "{footerTerms}",
  ]);

  expect("valid template passes validation", validateDocxTemplate(template), null);

  const broken = await docxWith(["{#lineItems} loop never closed"]);
  expect("broken template is rejected", validateDocxTemplate(broken) != null, true);

  const quote: QuoteDto = {
    id: "q1",
    conversationId: "c1",
    status: "DRAFT",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    completedAt: null,
    markupPercent: 0,
    customerName: null,
    customerAddress: null,
    customerPhone: null,
    chosenOptionGroup: null,
    lineItems: [
      {
        id: "l1", description: "20A breaker", quantity: 2, unit: "EA", unitPrice: 8.5,
        totalPrice: 17, pricebookCode: "B1:X", product: null, priceEstimated: false,
        estimateLink: null, priceSource: "Supplier A", isLabor: false, flags: [],
        ambiguousAction: null, optionGroup: null, sortOrder: 0,
        searchTerm: null, qboItemId: null, qboItemName: null,
      },
      {
        id: "l2", description: "Standard labor", quantity: 3, unit: "hr", unitPrice: 105,
        totalPrice: 315, pricebookCode: null, product: null, priceEstimated: false,
        estimateLink: null, priceSource: null, isLabor: true, flags: [],
        ambiguousAction: null, optionGroup: null, sortOrder: 1,
        searchTerm: null, qboItemId: null, qboItemName: null,
      },
    ],
    total: 332,
    optionTotals: [],
    blockingFlagCount: 0,
  };
  const branding: InvoiceBranding = {
    name: "ACME Fire", logoUrl: null, address: "1 Main St", phone: null, email: null,
    licenseNumber: "FL-123", website: "acmefire.com", footerTerms: null, // footer unset → blank
  };

  const doc = new Docxtemplater(new PizZip(template), {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => "",
  });
  doc.render(templateData(quote, branding));
  const text = extractText(doc.getZip().generate({ type: "nodebuffer" }) as Buffer);

  expect("company name filled", text.includes("QUOTE from ACME Fire"), true);
  expect("website filled", text.includes("acmefire.com"), true);
  expect("line loop repeats per item", [
    text.includes("20A breaker: 2 EA @ $8.50 = $17.00"),
    text.includes("Standard labor: 3 hr @ $105.00 = $315.00"),
  ], [true, true]);
  expect("total formatted", text.includes("Total: $332.00"), true);
  expect("unset branding renders blank, not a placeholder", text.includes("{footerTerms}"), false);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll template checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
