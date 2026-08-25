/**
 * Regression check for the per-company proposal document format.
 *
 * The boundaries this holds:
 *  - the DEFAULT is the estimate layout (owner decision 2026-08-25): company header, project
 *    block, the itemised line table with totals, signature line, service summary, terms —
 *    what EVERY company without a stored template now renders
 *  - the line table never misstates money: option-group lines print under their own
 *    alternative row and are never summed into the base Total
 *  - a bad stored template never reaches a technician: validation catches it, and rendering
 *    falls back to the default rather than throwing
 *  - BOTH formats render from the same blocks — hiding or reordering a section must show up
 *    in the .docx and the PDF alike, or the email and the download would disagree
 *
 * Renders real documents (no network, no database).
 *   npx tsx scripts/check-proposal-template.ts
 */
import {
  DEFAULT_PROPOSAL_BLOCKS,
  blocksOrDefault,
  fillTokens,
  validateProposalBlocks,
  type ProposalBlock,
} from "../src/copilot/estimating/proposalTemplate";
import {
  renderTemplatedProposalDocx,
  renderTemplatedProposalPdf,
} from "../src/copilot/estimating/proposalTemplateRender";
import {
  buildEstimateStyleDocx,
  mapEstimateQuote,
  renderProposalDocx,
  renderProposalPdf,
} from "../src/copilot/estimating/proposalEstimate";
import PizZip from "pizzip";
import type { ProposalInput } from "../src/copilot/estimating/proposalDocx";

/**
 * Text of a rendered .docx, for content assertions. PDF bytes are compressed, so grepping a
 * PDF buffer silently always "passes" an absence check — this reads the real document XML
 * instead. Both formats render from the same blocks, so asserting on the .docx proves the
 * block list reached the output.
 */
const docxText = (buffer: Buffer): string =>
  new PizZip(buffer).file("word/document.xml")!.asText().replace(/<[^>]+>/g, " ");

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  if (pass) console.log(`ok   ${label}`);
  else {
    failures++;
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const eq = (label: string, a: unknown, b: unknown) =>
  ok(label, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const TOKENS = {
  companyName: "Sample Electric",
  companyAddress: "236 West 27th Street",
  technicianName: "Alex Smith",
  licenseNumber: "EL-1234",
  companyPhone: "555-0100",
  companyEmail: "bids@sample.test",
};

const input: ProposalInput = {
  header: {
    companyName: "Sample Electric",
    companyAddress: "236 West 27th Street",
    companyPhone: "555-0100",
    companyEmail: "bids@sample.test",
    customerName: "Jane Doe",
    billingAddress: "42 Oak St",
    serviceAddress: "42 Oak St",
    technicianName: "Alex Smith",
    logoUrl: null,
    licenseNumber: "EL-1234",
  },
  projectTitle: "Panel Replacement",
  date: new Date("2026-08-24T12:00:00Z"),
  lineItems: [
    { code: "LB-020", description: "Minimum Service Call", quantity: 1, unit: "CALL", unitPrice: 175, totalPrice: 175 },
    { code: "LB-021", description: "Travel <30mi", quantity: 1, unit: "TRIP", unitPrice: 65, totalPrice: 65 },
    { description: "Replace one light bulb at standard ladder access", quantity: 0.5, unit: "HR", unitPrice: 75, totalPrice: 37.5 },
  ],
  scopeSections: [{ title: "Panel Work", bullets: ["Replace panel", "Test and verify"] }],
  total: 277.5,
  unpricedCount: 0,
};

// --- the default is the estimate layout ----------------------------------------------------
ok("default template is valid", validateProposalBlocks(DEFAULT_PROPOSAL_BLOCKS).length === 0);
ok(
  "default has the line-item table",
  DEFAULT_PROPOSAL_BLOCKS.some((b) => b.dynamic === "lineItems")
);
ok(
  "default has no bid-proposal legalese",
  !DEFAULT_PROPOSAL_BLOCKS.some((b) => ["exclusions", "assumptions"].includes(b.id))
);

// --- tokens ---------------------------------------------------------------------------------
eq(
  "tokens fill from the header (address included)",
  fillTokens("{{companyName}} at {{companyAddress}}", TOKENS),
  "Sample Electric at 236 West 27th Street"
);
eq(
  "an unknown token is left visible rather than silently dropped",
  fillTokens("{{nope}}", { ...TOKENS, companyName: "" }),
  "{{nope}}"
);

// --- validation rejects what would render broken --------------------------------------------
ok("a non-list is rejected", validateProposalBlocks({}).length > 0);
ok("an empty template is rejected", validateProposalBlocks([]).length > 0);
ok(
  "duplicate ids are rejected",
  validateProposalBlocks([
    { id: "a", visible: true, content: [{ format: "paragraph", text: "x" }] },
    { id: "a", visible: true, content: [{ format: "paragraph", text: "y" }] },
  ]).length > 0
);
ok(
  "an unknown dynamic type is rejected",
  validateProposalBlocks([{ id: "a", visible: true, dynamic: "nope" as never }]).length > 0
);
ok(
  "lineItems is a known dynamic type",
  validateProposalBlocks([{ id: "a", visible: true, dynamic: "lineItems" }]).length === 0
);
ok(
  "a static block with no content is rejected",
  validateProposalBlocks([{ id: "a", visible: true }]).length > 0
);
eq("a bad stored value falls back to the default", blocksOrDefault("garbage"), DEFAULT_PROPOSAL_BLOCKS);

async function main() {
  // --- both formats render the default estimate layout -------------------------------------
  const docx = await renderTemplatedProposalDocx(input, null);
  const pdf = await renderTemplatedProposalPdf(input, null);
  ok("default renders a .docx", docx.length > 1000);
  ok("default renders a PDF", pdf.length > 1000);
  const text = docxText(docx);

  // A garbage template must still produce a document (fallback), never throw.
  ok("a broken template still renders", (await renderTemplatedProposalPdf(input, { junk: 1 })).length > 1000);

  // The estimate layout's parts all reach the output.
  ok("company name prints in the header", text.includes("Sample Electric"));
  ok("company address prints", text.includes("236 West 27th Street"));
  ok("a coded line prints code and description", text.includes("LB-020 - Minimum Service Call"));
  ok("an uncoded line prints bare", text.includes("Replace one light bulb"));
  ok("quantities print with their unit", text.includes("0.5 HR"));
  ok("line totals print as money", text.includes("$37.50"));
  ok("the table Total row prints the base total", text.includes("$277.50"));
  ok("the signature line prints", text.includes("Customer Signature:"));
  ok("the service summary section prints", text.includes("Service Summary") && text.includes("PANEL WORK"));
  ok("the terms section prints", text.includes("Terms and Conditions") && text.includes("valid for 30 days"));
  // No logo configured = no logo — the templated path must not substitute the Clara logo.
  ok("no logo configured embeds no image", !new PizZip(docx).file(/word\/media\/.+/).length);

  // --- money correctness: option groups ----------------------------------------------------
  const withOptions: ProposalInput = {
    ...input,
    lineItems: [
      ...(input.lineItems ?? []),
      { description: "Alternative fixture upgrade", quantity: 1, unit: "EA", unitPrice: 100, totalPrice: 100, optionGroup: "Option A" },
    ],
    optionTotals: [{ name: "Option A", total: 100, combinedTotal: 377.5 }],
  };
  const optText = docxText(await renderTemplatedProposalDocx(withOptions, null));
  ok("an option line prints in the table", optText.includes("Alternative fixture upgrade"));
  ok("the option prints as an alternative row", optText.includes("Option — Option A (alternative)"));
  ok("the base Total is never the sum of alternatives", optText.includes("$277.50"));
  ok("the combined total prints beside the option", optText.includes("$377.50"));
  ok("the mutually-exclusive note prints", optText.includes("never combined"));

  // --- unpriced lines stay loud -------------------------------------------------------------
  const unpricedText = docxText(
    await renderTemplatedProposalDocx({ ...input, unpricedCount: 2 }, null)
  );
  ok("unpriced lines print the warning above the table", unpricedText.includes("not yet priced"));

  // --- empty data leaves no orphans ---------------------------------------------------------
  const emptyText = docxText(await renderTemplatedProposalDocx({ ...input, lineItems: [] }, null));
  ok("no lines = no table header", !emptyText.includes("Line Item"));
  const noPhone = docxText(
    await renderTemplatedProposalDocx(
      { ...input, header: { ...input.header, companyPhone: "" } },
      null
    )
  );
  ok("an empty phone prints no dangling label", !noPhone.includes("Phone:"));
  ok("the email label still prints beside its data", noPhone.includes("Email:"));

  // --- hiding a section takes effect in BOTH formats ----------------------------------------
  const hidden: ProposalBlock[] = DEFAULT_PROPOSAL_BLOCKS.map((b) =>
    b.id === "terms" ? { ...b, visible: false } : b
  );
  const hiddenPdf = await renderTemplatedProposalPdf(input, hidden);
  const hiddenDocx = await renderTemplatedProposalDocx(input, hidden);
  ok("hiding a section shrinks the PDF", hiddenPdf.length < pdf.length);
  ok("the hidden section's text is really gone", !docxText(hiddenDocx).includes("valid for 30 days"));

  // --- company-authored text reaches the output ---------------------------------------------
  const custom: ProposalBlock[] = [
    { id: "logo", visible: true, dynamic: "logo" },
    {
      id: "ours",
      heading: "OUR TERMS",
      visible: true,
      style: { align: "center", bold: true, fontFamily: "Times New Roman", fontSize: 12 },
      content: [{ format: "paragraph", text: "{{companyName}} guarantees all work for 2 years." }],
    },
    { id: "lines", visible: true, dynamic: "lineItems" },
  ];
  const customDocx = await renderTemplatedProposalDocx(input, custom);
  ok("a custom template renders a PDF", (await renderTemplatedProposalPdf(input, custom)).length > 1000);
  ok(
    "custom static text reaches the output with tokens filled",
    docxText(customDocx).includes("Sample Electric guarantees all work")
  );
  ok("the company's own heading reaches the output", docxText(customDocx).includes("OUR TERMS"));

  // An empty dynamic block must not leave its heading orphaned on the page.
  const photosOnly: ProposalBlock[] = [
    { id: "photos", heading: "PROJECT PHOTOS", visible: true, dynamic: "photos" },
  ];
  ok(
    "an empty photos section prints no orphan heading",
    !docxText(await renderTemplatedProposalDocx(input, photosOnly)).includes("PROJECT PHOTOS")
  );

  // --- the DEFAULT PDF is the job feature's own estimate document --------------------------
  // mapEstimateQuote is the money-carrying seam between the proposal flow and buildQuotePdf.
  const est = mapEstimateQuote({
    ...input,
    lineItems: [
      { code: "LB-020", description: "Minimum Service Call", quantity: 1, unit: "CALL", unitPrice: 175, totalPrice: 175, priceSource: "Labor Rates" },
      { description: "Replace one light bulb", quantity: 0.5, unit: "HR", unitPrice: 75, totalPrice: 37.5, isLabor: true },
      { description: "Replacement bulb TBD", quantity: 1, unit: "EA", unitPrice: null, totalPrice: null, unmatched: true },
    ],
    total: 212.5,
    terms: ["Net 30.", "Warranty: 1 year on labor."],
  });
  eq("an unpriced line maps to a PENDING $0.00 row",
     [est.lineItems[2].code, est.lineItems[2].unitPrice, est.lineItems[2].lineTotal],
     ["PENDING", 0, 0]);
  eq("a labor line maps to the labor kind", est.lineItems[1].kind, "labor");
  eq("the price source becomes the row's sub-line", est.lineItems[0].sourceSheet, "Labor Rates");
  eq("labor subtotal splits from materials+services",
     [est.laborSubtotal, est.materialsServicesSubtotal], [37.5, 175]);
  eq("the grand total is the quote's total, never re-summed", est.total, 212.5);
  eq("company terms reach the Terms section", est.customerNotes, ["Net 30.", "Warranty: 1 year on labor."]);
  ok("scope bullets fill the service summary", est.assumptions.includes("Replace panel"));

  // The dispatcher: default → estimate document; stored template → the company's blocks;
  // option groups → the block layout (the estimate document can't express alternatives).
  ok("default renders via the estimate document", (await renderProposalPdf(input, null)).length > 1000);
  ok(
    "a stored template still renders via blocks",
    (await renderProposalPdf(input, custom)).length > 1000
  );
  ok(
    "option-group quotes render via blocks (alternatives stay correct)",
    (await renderProposalPdf(withOptions, null)).length > 1000
  );

  // The .docx twin: the Download button's Word file carries the SAME estimate document as the
  // PDF — layout, columns, PENDING rows, totals — so the two downloads never disagree.
  const estDocx = docxText(
    await buildEstimateStyleDocx({
      ...input,
      lineItems: [
        ...(input.lineItems ?? []),
        { description: "Bulb TBD", quantity: 1, unit: "EA", unitPrice: null, totalPrice: null, unmatched: true },
      ],
      terms: ["Net 30."],
    })
  );
  for (const needle of [
    "Billing Address",
    "Service Address",
    "Estimate #",
    "Line Item",
    "Quoted",
    "LB-020 - Minimum Service Call",
    "PENDING - Bulb TBD",
    "Subtotal",
    "Net Amount",
    "$277.50",
    "Customer Signature",
    "Service Summary",
    "Terms and Conditions",
    "• Net 30.",
  ])
    ok(`estimate .docx carries "${needle}"`, estDocx.includes(needle));

  // Both formats take the SAME dispatcher branch: an option-group quote must fall back to
  // blocks in the .docx too, or the Word file would misstate what the PDF shows.
  const optDocxText = docxText(await renderProposalDocx(withOptions, null));
  ok("option-group .docx uses the block layout like the PDF", optDocxText.includes("alternative"));
  ok(
    "default .docx is the estimate document",
    docxText(await renderProposalDocx(input, null)).includes("Net Amount")
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll proposal-template checks passed");
}

main();
