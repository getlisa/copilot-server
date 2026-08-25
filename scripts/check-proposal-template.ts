/**
 * Regression check for the per-company proposal document format.
 *
 * The boundaries this holds:
 *  - the default block list still mirrors the hardcoded proposal's STATIC_* lists, so
 *    "customize our proposal" starts from what a company actually gets today
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
import PizZip from "pizzip";
import {
  STATIC_ASSUMPTIONS,
  STATIC_COORDINATION,
  STATIC_EXCLUSIONS,
  type ProposalInput,
} from "../src/copilot/estimating/proposalDocx";

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

const input: ProposalInput = {
  header: {
    companyName: "Sample Electric",
    companyAddress: "",
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
  scopeSections: [{ title: "Panel Work", bullets: ["Replace panel", "Test and verify"] }],
  total: 1825,
  unpricedCount: 0,
};

// --- the default mirrors the hardcoded proposal -------------------------------------------
const listOf = (id: string) =>
  DEFAULT_PROPOSAL_BLOCKS.find((b) => b.id === id)?.content?.find((p) => p.format !== "paragraph")
    ?.items;
eq("default exclusions match the built-in list", listOf("exclusions"), STATIC_EXCLUSIONS);
eq("default assumptions match the built-in list", listOf("assumptions"), STATIC_ASSUMPTIONS);
eq(
  "default coordination matches the built-in list",
  DEFAULT_PROPOSAL_BLOCKS.find((b) => b.id === "general-conditions")?.content?.[0]?.items,
  STATIC_COORDINATION
);
ok("default template is valid", validateProposalBlocks(DEFAULT_PROPOSAL_BLOCKS).length === 0);

// --- tokens ------------------------------------------------------------------------------
eq(
  "tokens fill from the header",
  fillTokens('{{companyName}} ("Contractor") — lic {{licenseNumber}}', {
    companyName: "Sample Electric",
    technicianName: "Alex Smith",
    licenseNumber: "EL-1234",
    companyPhone: "555-0100",
    companyEmail: "bids@sample.test",
  }),
  'Sample Electric ("Contractor") — lic EL-1234'
);
eq(
  "an unknown token is left visible rather than silently dropped",
  fillTokens("{{nope}}", {
    companyName: "",
    technicianName: "",
    licenseNumber: "",
    companyPhone: "",
    companyEmail: "",
  }),
  "{{nope}}"
);

// --- validation rejects what would render broken ------------------------------------------
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
  "a static block with no content is rejected",
  validateProposalBlocks([{ id: "a", visible: true }]).length > 0
);
ok(
  "an empty list block is rejected",
  validateProposalBlocks([{ id: "a", visible: true, content: [{ format: "bullets", items: [] }] }])
    .length > 0
);
eq("a bad stored value falls back to the default", blocksOrDefault("garbage"), DEFAULT_PROPOSAL_BLOCKS);

async function main() {
  // --- both formats render from the default ----------------------------------------------
  const docx = await renderTemplatedProposalDocx(input, DEFAULT_PROPOSAL_BLOCKS);
  const pdf = await renderTemplatedProposalPdf(input, DEFAULT_PROPOSAL_BLOCKS);
  ok("default renders a .docx", docx.length > 1000);
  ok("default renders a PDF", pdf.length > 1000);

  // A garbage template must still produce a document (fallback), never throw.
  ok("a broken template still renders", (await renderTemplatedProposalPdf(input, { junk: 1 })).length > 1000);

  // --- hiding a section takes effect in BOTH formats -------------------------------------
  const hidden: ProposalBlock[] = DEFAULT_PROPOSAL_BLOCKS.map((b) =>
    b.id === "exclusions" ? { ...b, visible: false } : b
  );
  const [fullPdf, hiddenPdf, fullDocx, hiddenDocx] = [
    pdf,
    await renderTemplatedProposalPdf(input, hidden),
    docx,
    await renderTemplatedProposalDocx(input, hidden),
  ];
  ok("hiding a section shrinks the PDF", hiddenPdf.length < fullPdf.length);
  ok("hiding a section shrinks the .docx", hiddenDocx.length < fullDocx.length);
  ok(
    "the visible section's text is in the full .docx",
    docxText(fullDocx).includes("specifically EXCLUDED")
  );
  ok(
    "the hidden section's text is really gone",
    !docxText(hiddenDocx).includes("specifically EXCLUDED")
  );

  // --- company-authored text reaches the output -----------------------------------------
  const custom: ProposalBlock[] = [
    { id: "logo", visible: true, dynamic: "logo" },
    {
      id: "ours",
      heading: "OUR TERMS",
      visible: true,
      style: { align: "center", bold: true, fontFamily: "Times New Roman", fontSize: 12 },
      content: [{ format: "paragraph", text: "Sample Electric guarantees all work for 2 years." }],
    },
    { id: "cost", visible: true, dynamic: "costSummary" },
  ];
  const customPdf = await renderTemplatedProposalPdf(input, custom);
  const customDocx = await renderTemplatedProposalDocx(input, custom);
  ok("a custom template renders a PDF", customPdf.length > 1000);
  ok("custom static text reaches the output", docxText(customDocx).includes("guarantees all work"));
  ok("the company's own heading reaches the output", docxText(customDocx).includes("OUR TERMS"));
  ok(
    "a token in company text is filled, not printed raw",
    docxText(await renderTemplatedProposalDocx(input, DEFAULT_PROPOSAL_BLOCKS)).includes(
      "Sample Electric (\u201cContractor\u201d)"
    ) || docxText(fullDocx).includes("Sample Electric")
  );

  // An empty dynamic block must not leave its heading orphaned on the page.
  const photosOnly: ProposalBlock[] = [
    { id: "photos", heading: "PROJECT PHOTOS", visible: true, dynamic: "photos" },
  ];
  ok(
    "an empty photos section prints no orphan heading",
    !docxText(await renderTemplatedProposalDocx(input, photosOnly)).includes("PROJECT PHOTOS")
  );

  // --- bug regressions (2026-08-24) -------------------------------------------------------
  // 1. No logo configured = no logo: the templated path must not substitute the Clara logo.
  const noLogoDocx = await renderTemplatedProposalDocx(input, DEFAULT_PROPOSAL_BLOCKS);
  ok(
    "letterhead without a logo embeds no image",
    !new PizZip(noLogoDocx).file(/word\/media\/.+/).length
  );
  // 3. The letterhead split: title is editable text, contact line drops with its data.
  const title = DEFAULT_PROPOSAL_BLOCKS.find((b) => b.id === "title");
  ok("the document title is a static (editable) block", !!title && !title.dynamic);
  ok("the default title prints", docxText(noLogoDocx).includes("Bid Proposal"));
  const noContact = {
    ...input,
    header: { ...input.header, companyPhone: "", companyEmail: "" },
  };
  ok(
    "an empty contact line prints nothing",
    !docxText(await renderTemplatedProposalDocx(noContact, DEFAULT_PROPOSAL_BLOCKS)).includes("555-0100 ")
  );

  // 2. Prepared By is editable static text by default, driven by tokens…
  const preparedBy = DEFAULT_PROPOSAL_BLOCKS.find((b) => b.id === "prepared-by");
  ok("prepared-by is a static (editable) block", !!preparedBy && !preparedBy.dynamic);
  const defaultText = docxText(noLogoDocx);
  ok("prepared-by prints the company name", defaultText.includes("Sample Electric"));
  ok("prepared-by prints the phone", defaultText.includes("555-0100"));
  ok(
    "prepared-by prints the licence with its label",
    defaultText.includes("Contractor License:") && defaultText.includes("EL-1234")
  );
  // …and a token line whose data is missing vanishes entirely, label included.
  const noLicense = {
    ...input,
    header: { ...input.header, licenseNumber: "", companyPhone: "" },
  };
  const sparseText = docxText(await renderTemplatedProposalDocx(noLicense, DEFAULT_PROPOSAL_BLOCKS));
  ok("an empty licence prints no dangling label", !sparseText.includes("Contractor License:"));
  ok("an empty phone prints no blank line artifacts", !sparseText.includes("555-0100"));
  ok("a deliberate label-only line still prints", sparseText.includes("PAYMENT TERMS:"));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll proposal-template checks passed");
}

main();
