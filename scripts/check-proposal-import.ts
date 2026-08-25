/**
 * Regression check for proposal-document IMPORT (the extraction half).
 *
 * What this holds: a company's uploaded .docx must come back with the formatting it actually
 * had — alignment, bold, italic, font, size, colour, and bullet-vs-numbered. Getting the list
 * kind wrong silently rewrites their document (every numbered clause becomes a bullet), and
 * getting a style wrong means the "same formatting by default" promise is broken.
 *
 * Renders a document with known formatting, re-imports it, and asserts the round trip.
 *
 * Pure — no network, no database, NO model credentials: extraction lives in proposalImport.ts
 * precisely so this can run inside the Docker build. Do not import proposalImportClassify here.
 *   npx tsx scripts/check-proposal-import.ts
 */
import {
  assembleImportedBlocks,
  extractDocxParagraphs,
  ProposalImportError,
} from "../src/copilot/estimating/proposalImport";
import { renderTemplatedProposalDocx } from "../src/copilot/estimating/proposalTemplateRender";
import type { ProposalBlock } from "../src/copilot/estimating/proposalTemplate";
import type { ProposalInput } from "../src/copilot/estimating/proposalDocx";

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
    companyPhone: "",
    companyEmail: "",
    customerName: "",
    billingAddress: "",
    serviceAddress: "",
    technicianName: "",
    logoUrl: null,
    licenseNumber: "",
  },
  projectTitle: "T",
  date: new Date("2026-08-24T12:00:00Z"),
  scopeSections: [],
  total: 100,
  unpricedCount: 0,
};

async function main() {
  const blocks: ProposalBlock[] = [
    {
      id: "styled",
      heading: "OUR TERMS",
      visible: true,
      style: { align: "center", bold: true, fontFamily: "Times New Roman", fontSize: 14, color: "C00000" },
      content: [{ format: "paragraph", text: "Centered bold red Times at 14pt." }],
    },
    { id: "b", visible: true, content: [{ format: "bullets", items: ["Bullet A", "Bullet B"] }] },
    { id: "n", visible: true, content: [{ format: "numbered", items: ["Numbered A", "Numbered B"] }] },
    {
      id: "plain",
      visible: true,
      style: { italic: true, fontSize: 8 },
      content: [{ format: "paragraph", text: "Small italic footnote." }],
    },
  ];

  const { paragraphs, formattingInferred } = extractDocxParagraphs(
    await renderTemplatedProposalDocx(input, blocks)
  );
  ok("a .docx reports formatting as read, not inferred", formattingInferred === false);

  const find = (needle: string) => paragraphs.find((p) => p.text.includes(needle));

  const styled = find("Centered bold red");
  eq("alignment round-trips", styled?.style.align, "center");
  eq("bold round-trips", styled?.style.bold, true);
  eq("font family round-trips", styled?.style.fontFamily, "Times New Roman");
  eq("font size round-trips (half-points → points)", styled?.style.fontSize, 14);
  eq("colour round-trips", styled?.style.color, "C00000");

  const footnote = find("Small italic footnote");
  eq("italic round-trips", footnote?.style.italic, true);
  eq("a small size round-trips", footnote?.style.fontSize, 8);

  // The one that silently rewrites a company's document if it regresses.
  eq("a bullet list stays bullets", find("Bullet A")?.list, "bullets");
  eq("a numbered list stays numbered", find("Numbered A")?.list, "numbered");
  eq("every list item is kept", paragraphs.filter((p) => p.list).length, 4);

  // Headings come through as ordinary paragraphs; the LLM step is what makes them headings.
  ok("the section heading text survives", !!find("OUR TERMS"));

  // Black is the default, so it must not be stored as an explicit colour override.
  eq("default black is not stored as a colour", find("Bullet A")?.style.color, undefined);

  // --- classified-block assembly (the pure half of the LLM import) ------------------------
  const importedParagraphs = [
    { text: "EXCLUSIONS", style: {} },
    { text: "The following are excluded:", style: {} },
    { text: "Painting of any kind", style: {}, list: "bullets" as const },
    { text: "Exclusions apply as stated above.", style: {} },
  ];
  const assembled = assembleImportedBlocks(importedParagraphs, [
    { heading: "EXCLUSIONS", dynamic: null, paragraphIndexes: [0, 1, 2, 3] },
    { heading: null, dynamic: "costSummary", paragraphIndexes: [] },
  ]);
  // An imported document can never carry its logo or photos through extraction, so the logo
  // block is prepended and the photos block appended — both there by default on every import.
  eq("every import starts with the company logo block", assembled[0]?.dynamic, "logo");
  eq("every import ends with the photos block", assembled[assembled.length - 1]?.dynamic, "photos");
  const alreadyPlaced = assembleImportedBlocks([], [
    { heading: null, dynamic: "logo", paragraphIndexes: [] },
    { heading: "PHOTOS", dynamic: "photos", paragraphIndexes: [] },
  ]);
  eq(
    "a logo/photos block the classifier already placed is not doubled",
    [
      alreadyPlaced.filter((b) => b.dynamic === "logo").length,
      alreadyPlaced.filter((b) => b.dynamic === "photos").length,
    ],
    [1, 1]
  );
  // The bug: the classifier lists the heading paragraph in the block's own indexes, printing
  // the title twice — once as the heading, once as body text.
  eq(
    "a heading paragraph re-listed as content is dropped",
    assembled[1]?.content?.[0]?.text,
    "The following are excluded:"
  );
  eq("the heading itself is kept on the block", assembled[1]?.heading, "EXCLUSIONS");
  ok(
    "later text merely MENTIONING the heading words is kept",
    assembled[1]?.content?.some((part) => part.text?.includes("Exclusions apply"))
  );
  eq("a dynamic block passes through", assembled[2]?.dynamic, "costSummary");

  // Garbage in must fail loudly, not produce an empty template.
  let threw = false;
  try {
    extractDocxParagraphs(Buffer.from("this is not a docx"));
  } catch (err) {
    threw = err instanceof ProposalImportError;
  }
  ok("a non-.docx buffer is rejected with a clear error", threw);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll proposal-import checks passed");
}

main();
