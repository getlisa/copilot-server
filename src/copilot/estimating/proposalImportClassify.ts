import logger from "../../lib/logger";
import { callStructured } from "../estimate/estimateService";
import {
  DEFAULT_PROPOSAL_BLOCKS,
  DYNAMIC_BLOCK_TYPES,
  validateProposalBlocks,
  type DynamicBlockType,
  type ProposalBlock,
  type StaticFormat,
  type StaticPart,
} from "./proposalTemplate";
import {
  ProposalImportError,
  assembleImportedBlocks,
  extractDocxParagraphs,
  extractPdfParagraphs,
  type ClassifiedBlock,
  type ExtractResult,
  type ExtractedParagraph,
} from "./proposalImport";

/**
 * The LLM half of proposal import: deciding which extracted paragraphs are the company's own
 * boilerplate and which are placeholders for quote data. Kept apart from proposalImport.ts so
 * that the pure extraction stays importable where no model credentials exist (see the note
 * at the top of that file).
 */

// ------------------------------------------------------------------ LLM classification

const CLASSIFY_SCHEMA = {
  name: "proposal_blocks",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      blocks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            heading: { type: ["string", "null"] },
            dynamic: { type: ["string", "null"], enum: [...DYNAMIC_BLOCK_TYPES, null] },
            /** Indexes into the numbered paragraph list, for a static block. */
            paragraphIndexes: { type: "array", items: { type: "integer" } },
          },
          required: ["heading", "dynamic", "paragraphIndexes"],
        },
      },
    },
    required: ["blocks"],
  },
};

const CLASSIFY_PROMPT = `You are converting a contractor's existing bid-proposal document into an editable template.

You are given the document's paragraphs, numbered. Group them into ordered BLOCKS, and for each block decide whether it is STATIC or DYNAMIC.

STATIC = wording the contractor reuses on every proposal: general scope, exclusions, assumptions, general conditions, code compliance, payment terms, warranty, validity notes, signature boilerplate. Keep their exact words — list the paragraph indexes that belong to the block.

DYNAMIC = a place where THIS QUOTE's data is filled in. Do not keep the sample text; return the matching type instead:
- logo — the company logo image
- contactLine — the company's phone/email contact line under the letterhead
(The document's TITLE — "Bid Proposal", "Estimate", "Quotation" — is STATIC text: keep the company's own title wording as a static block.)
- projectBlock — project name, customer name/address/phone, contractor, date lines
- scopeOfWork — the itemised description of the work to be performed on this job
- lineItems — a table of line items with rates/quantities/amounts per row
- costSummary — prose prices, totals, subtotals, cost-in-words (not a per-line table)
- preparedBy — the "prepared by" name/signature block
- photos — a photos/attachments section

Rules:
- Output blocks in the order they appear in the document.
- A block is EITHER static (paragraphIndexes non-empty, dynamic null) OR dynamic (dynamic set, paragraphIndexes empty).
- Every paragraph index appears in at most one block; a paragraph that is sample DATA for a dynamic block (a customer's name, a price, an item row) belongs to NO block — the dynamic block regenerates it.
- heading: the block's section heading if the document has one (e.g. "EXCLUSIONS"), else null. Do not invent headings. The heading paragraph itself must NOT also appear in paragraphIndexes — the heading field carries it; listing it again prints the title twice.
- Do not merge unrelated sections, and do not split a single section's paragraphs across blocks.
- If a document has no recognisable dynamic content at all, still emit the static blocks you found.`;

/**
 * Group extracted paragraphs into static/dynamic blocks. Falls back to the default template
 * on any failure — an import that cannot be classified must not hand the admin an empty
 * editor. Every result is reviewed in the editor before it is saved.
 */
export async function classifyParagraphs(
  paragraphs: ExtractedParagraph[]
): Promise<{ blocks: ProposalBlock[]; usedFallback: boolean }> {
  const numbered = paragraphs
    .map((p, i) => `[${i}]${p.list ? ` (${p.list} item)` : ""} ${p.text}`)
    .join("\n");

  let raw: unknown;
  try {
    ({ raw } = await callStructured({
      system: CLASSIFY_PROMPT,
      userContent: `DOCUMENT PARAGRAPHS:\n${numbered}`,
      jsonSchema: CLASSIFY_SCHEMA,
    }));
  } catch (err) {
    logger.warn("Proposal import classification failed; using the default template", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { blocks: DEFAULT_PROPOSAL_BLOCKS, usedFallback: true };
  }

  const out = raw as { blocks?: ClassifiedBlock[] };
  const blocks = assembleImportedBlocks(paragraphs, out?.blocks ?? []);

  if (validateProposalBlocks(blocks).length > 0) {
    logger.warn("Proposal import produced an invalid template; using the default", {
      problems: validateProposalBlocks(blocks).slice(0, 3),
    });
    return { blocks: DEFAULT_PROPOSAL_BLOCKS, usedFallback: true };
  }
  return { blocks, usedFallback: false };
}

export interface ImportResult {
  blocks: ProposalBlock[];
  /** Shown to the admin above the editor — never swallowed. */
  warnings: string[];
}

/** Extract + classify an uploaded proposal document into an editable template. */
export async function importProposalDocument(
  buffer: Buffer,
  filename: string
): Promise<ImportResult> {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  let extracted: ExtractResult;
  if (ext === "docx") extracted = extractDocxParagraphs(buffer);
  else if (ext === "pdf") extracted = await extractPdfParagraphs(buffer);
  else
    throw new ProposalImportError(
      `Unsupported file type ".${ext}" — upload the proposal as .docx (formatting is read exactly) or .pdf (formatting is estimated)`
    );

  const { blocks, usedFallback } = await classifyParagraphs(extracted.paragraphs);
  const warnings: string[] = [];
  if (extracted.formattingInferred)
    warnings.push(
      "This was a PDF, which carries no paragraph structure — fonts, sizes and alignment were " +
        "estimated from the page layout. Check the formatting in the editor before saving."
    );
  if (usedFallback)
    warnings.push(
      "The document's sections could not be identified, so the standard proposal was loaded " +
        "instead. Edit it here, or re-upload a clearer document."
    );
  return { blocks, warnings };
}
