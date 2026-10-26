/**
 * Regression check: each DTB Fire Protection HTML proposal (dtb/retrofit, service, inspection)
 * renders its work list, lump-sum price and exclusions with no leaked tokens.
 *   npx tsx scripts/check-html-dtb.ts [outDir]
 */
import { writeFileSync } from "fs";
import {
  htmlTemplateData,
  loadHtmlTemplate,
} from "../src/copilot/estimating/html/htmlProposal";
import { renderHtmlTemplate } from "../src/copilot/estimating/html/htmlTemplate";
import type { ProposalInput } from "../src/copilot/estimating/proposalDocx";

const input: ProposalInput = {
  header: {
    companyName: "DTB Fire Protection, Inc.",
    companyAddress: "868 W. Street Road\nSuite #307\nWarminister, PA, 18974",
    companyPhone: "(215) 469-3473",
    companyEmail: "dtbfireprotectionemail@gmail.com",
    customerName: "Climatic Testing System",
    customerPhone: "(689) 779-9890",
    billingAddress: "2367 North Penn Road\nHatfield, PA, 19440",
    serviceAddress: "2367 North Penn Road\nHatfield, PA, 19440",
    technicianName: "Dan Hinkle",
    logoUrl: null,
  } as ProposalInput["header"],
  proposalNumber: "E005615-3",
  date: new Date("2026-10-23"),
  projectTitle: "the retrofit of the automatic wet fire sprinkler system",
  scopeSections: [
    {
      title: "Retrofit",
      bullets: [
        "All sprinklers will be installed uniform throughout the proposed ceiling with respect to walls, light fixtures and HVAC diffusers.",
        "Proposal is based on adequate water supply provided from the existing sprinkler system.",
      ],
    },
  ],
  lineItems: [
    {
      description: "Design/Shop Drawing/PE Stamp",
      quantity: 1,
      unitPrice: 1500,
      totalPrice: 1500,
    },
    {
      description: "19' Lift Rental Week",
      quantity: 1,
      unitPrice: 1186,
      totalPrice: 1186,
    },
    {
      description: "Wet Retrofit of (105) white concealed sprinklers",
      quantity: 1,
      unitPrice: 21500,
      totalPrice: 21500,
    },
    {
      description: "Final AHJ Inspection",
      quantity: 1,
      unitPrice: 500,
      totalPrice: 500,
    },
  ],
  exclusions: [
    "Township Permit Fees",
    "Electrical and/or Alarm Wiring",
    "Hydraulic Calculations",
    "Man Lift",
  ],
  notes: "Due April, 2024",
  total: 24686,
  taxRatePercent: null,
} as ProposalInput;

const FILES: Record<string, string[]> = {
  retrofit: ["total price of:$24,686.00"],
  service: ["total price of: $24,686.00", "$165.00"],
  inspection: [
    "(1) Wet Retrofit of (105) white concealed sprinklers @ $21,500.00 each",
    "$21,500.00",
  ],
};

async function main() {
  const data = await htmlTemplateData(input);
  for (const [name, extra] of Object.entries(FILES)) {
    const template = loadHtmlTemplate(`dtb/${name}.html`);
    if (!template) throw new Error(`template missing: ${name}`);
    const html = renderHtmlTemplate(template, data);
    const must = [
      "Wet Retrofit of (105) white concealed sprinklers",
      "Township Permit Fees",
      "Technician:</b> Dan Hinkle",
      "13. If any provision",
      ...extra,
    ];
    const missing = must.filter((s) => !html.includes(s));
    const leaked = html.match(/\{\{[^}]+\}\}/g) ?? [];
    if (process.argv[2])
      writeFileSync(`${process.argv[2]}/dtb-${name}.html`, html);
    if (missing.length || leaked.length) {
      console.error(`FAIL ${name} missing:`, missing, "leaked:", leaked);
      process.exit(1);
    }
    console.log(`ok   dtb/${name}.html renders`);
  }
}
main();
