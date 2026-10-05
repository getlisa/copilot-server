/**
 * Regression check: an HTML proposal template prints mutually-exclusive options as their own
 * priced sections (baseLineItems / options), and never sums them.
 *   npx tsx scripts/check-html-options.ts [out.html]
 */
import { writeFileSync } from "fs";
import { htmlTemplateData, loadHtmlTemplate } from "../src/copilot/estimating/html/htmlProposal";
import { renderHtmlTemplate } from "../src/copilot/estimating/html/htmlTemplate";
import type { ProposalInput } from "../src/copilot/estimating/proposalDocx";

const input: ProposalInput = {
  header: {
    companyName: "Pierce Electric",
    companyAddress: "4680 E 2nd St, Suite A",
    companyPhone: "(707) 875-6632",
    companyEmail: "laura@pierce-inc.com",
    licenseNumber: "C-10 902345",
    website: "http://www.pierce-inc.com",
    customerName: "Laura Pierce",
    billingAddress: "29 Garthe Ct\nVallejo, CA 94591",
    serviceAddress: "2725 White Alder Ct, Fairfield, CA 94533",
    technicianName: "Tech",
    logoUrl: null,
  } as ProposalInput["header"],
  proposalNumber: "841",
  date: new Date("2026-09-28"),
  projectTitle: "EV Charger Circuit",
  facility: "2725 White Alder Ct\nFairfield, CA 94533",
  scopeSections: [{ title: "EV charger circuit", bullets: ["60 amp GFI breaker", "4/3 Romex thru crawl space"] }],
  lineItems: [
    { description: "New 60 amp, EV Charger Circuit & Connection", quantity: 1, unitPrice: 3125, totalPrice: 3125 },
    { description: "Install Owner furnished Ceiling Fan", quantity: 1, unitPrice: 528.5, totalPrice: 528.5, optionGroup: "Option 2 - Ceiling Fan" },
    { description: "Premium Subpanel Replacement", quantity: 1, unitPrice: 1020, totalPrice: 1020, optionGroup: "Option 3 - Subpanel" },
  ],
  total: 3125,
  taxRatePercent: 8.375,
  taxAmount: 261.72,
  totalWithTax: 3386.72,
  optionTotals: [
    { name: "Option 2 - Ceiling Fan", total: 528.5, combinedTotal: 3653.5, taxAmount: 305.98, combinedTotalWithTax: 3959.48 },
    { name: "Option 3 - Subpanel", total: 1020, combinedTotal: 4145, taxAmount: 347.14, combinedTotalWithTax: 4492.14 },
  ],
} as ProposalInput;

async function main() {
  const template = loadHtmlTemplate("pierce-electric.html");
  if (!template) throw new Error("template missing");
  const html = renderHtmlTemplate(template, await htmlTemplateData(input));
  const must = [
    "Option 2 - Ceiling Fan",
    "Option 3 - Subpanel",
    "$3,959.48",
    "$4,492.14",
    "Sales tax (8.375%): $305.98",
    "Base scope subtotal: $3,125.00",
  ];
  const missing = must.filter((s) => !html.includes(s));
  const leaked = html.match(/\{\{[^}]+\}\}/g) ?? [];
  // The base table must not list option lines; the summed figure must never appear.
  const bad = [...(html.includes("$4,673.50") ? ["options summed ($4,673.50)"] : []), ...leaked];
  if (process.argv[2]) writeFileSync(process.argv[2], html);
  if (missing.length || bad.length) {
    console.error("FAIL missing:", missing, "bad:", bad);
    process.exit(1);
  }
  console.log("ok   html options render");
}
main();
