/**
 * Per-company proposal document model — the format a company's own bid proposal is rendered
 * from, for BOTH the emailed PDF and the downloaded .docx.
 *
 * One stored block list, two renderers: that is the whole point. The alternative (a binary
 * .docx template) would need a LibreOffice conversion step to email as PDF, and the two
 * outputs could drift apart. Here they cannot — `renderBlocksDocx` and `renderBlocksPdf`
 * walk the same array.
 *
 * A block is either STATIC (text the company authored, which they control the wording and
 * formatting of) or DYNAMIC (content that comes from the quote — line items, totals, the
 * customer block, photos). Dynamic blocks keep their built-in rendering on purpose: a company
 * can reorder, hide and restyle them, but cannot restructure a pricing table into something
 * that misstates a price.
 *
 * Companies with no stored template render DEFAULT_PROPOSAL_BLOCKS — the estimate layout the
 * platform's job feature shows (owner decision 2026-08-25). The admin editor starts from the
 * same default.
 */

/** Content that comes from the quote, never authored by the company. */
export type DynamicBlockType =
  /** The company logo image. Prints nothing when no logo is configured. */
  | "logo"
  /** Phone | email line, joined from whichever the company has configured. */
  | "contactLine"
  /** Project / Customer / Contractor / Date lines. */
  | "projectBlock"
  /** Numbered DETAILED SCOPE OF WORK sections from the narrative. */
  | "scopeOfWork"
  /** Itemized table of the quote's lines with rate/qty/total and the totals rows. */
  | "lineItems"
  /** Unpriced warning, base/option totals, cost-in-words. */
  | "costSummary"
  /** Company name + technician name. */
  | "preparedBy"
  /** Attached job photos. */
  | "photos";

export const DYNAMIC_BLOCK_TYPES: DynamicBlockType[] = [
  "logo",
  "contactLine",
  "projectBlock",
  "scopeOfWork",
  "lineItems",
  "costSummary",
  "preparedBy",
  "photos",
];

/**
 * Formatting the admin controls per block. Deliberately a small set: these are the attributes
 * that survive a round trip through BOTH docx and PDF. Anything richer (columns, floating
 * shapes, tables inside static text) cannot be reproduced in both, so it is not offered
 * rather than being offered and silently dropped in one format.
 */
export interface BlockStyle {
  align?: "left" | "center" | "right";
  bold?: boolean;
  italic?: boolean;
  /** Font family name as Word/PDF know it, e.g. "Helvetica", "Times New Roman". */
  fontFamily?: string;
  /** Point size. */
  fontSize?: number;
  /** Hex without the leading #, e.g. "C00000". */
  color?: string;
}

export type StaticFormat = "paragraph" | "bullets" | "numbered";

export interface StaticPart {
  format: StaticFormat;
  /** paragraph: the text. bullets/numbered: ignored. */
  text?: string;
  /** bullets/numbered: the list items. */
  items?: string[];
  /** Bold run printed before the text, e.g. "Coordination:". */
  label?: string;
  /** Overrides the block's style for this part only. */
  style?: BlockStyle;
}

export interface ProposalBlock {
  /** Stable id so the editor can reorder without losing which block is which. */
  id: string;
  /** Underlined ALL-CAPS section header. Omit for an unheaded block. */
  heading?: string;
  /** Hidden blocks are kept in the stored template so un-hiding restores them intact. */
  visible: boolean;
  style?: BlockStyle;
  /** Set for a dynamic block; `content` is then ignored. */
  dynamic?: DynamicBlockType;
  /** Set for a static block. */
  content?: StaticPart[];
}

/**
 * Tokens usable inside static text. Kept tiny and quote-independent: a company writes
 * boilerplate, not a mail merge — anything quote-specific belongs in a dynamic block.
 */
export interface TemplateTokens {
  companyName: string;
  companyAddress: string;
  technicianName: string;
  licenseNumber: string;
  companyPhone: string;
  companyEmail: string;
}

export function fillTokens(text: string, tokens: TemplateTokens): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (raw, key: string) =>
    key in tokens ? String(tokens[key as keyof TemplateTokens] ?? "") : raw
  );
}

/**
 * The default proposal EVERY company starts from: the estimate layout the platform's job
 * feature already shows (owner decision 2026-08-25) — company header, customer/project info,
 * the itemized line table with totals, signature line, service summary, terms. The old
 * "Bid Proposal" legalese default is gone; a company that wants those sections adds them as
 * static blocks (all the block types it used still exist).
 *
 * Label + token paragraphs (label: "Phone:", text: "{{companyPhone}}") vanish entirely when
 * the token fills empty — the tokenLineIsEmpty rule — so a company without an email prints
 * no dangling "Email:" label.
 */
export const DEFAULT_PROPOSAL_BLOCKS: ProposalBlock[] = [
  { id: "logo", visible: true, dynamic: "logo", style: { align: "left" } },
  {
    id: "company-header",
    visible: true,
    content: [
      { format: "paragraph", text: "{{companyName}}", style: { bold: true, fontSize: 12 } },
      { format: "paragraph", text: "{{companyAddress}}" },
      { format: "paragraph", label: "Phone:", text: "{{companyPhone}}" },
      { format: "paragraph", label: "Email:", text: "{{companyEmail}}" },
    ],
  },
  { id: "project", visible: true, dynamic: "projectBlock" },
  { id: "line-items", visible: true, dynamic: "lineItems" },
  {
    id: "signature",
    visible: true,
    content: [
      { format: "paragraph", text: "Customer Signature: ____________________________" },
    ],
  },
  { id: "service-summary", heading: "Service Summary", visible: true, dynamic: "scopeOfWork" },
  {
    id: "terms",
    heading: "Terms and Conditions",
    visible: true,
    content: [
      {
        format: "paragraph",
        text:
          "All work to be performed in a professional and workmanlike manner. This estimate " +
          "is valid for 30 days from the date of issuance.",
      },
    ],
  },
  { id: "photos", heading: "Project Photos", visible: true, dynamic: "photos" },
];

/**
 * Validate a stored/edited template before it is saved or rendered. Returns a list of
 * problems — empty means usable. A bad stored template must never reach a technician's
 * download, so callers reject on save and fall back to the default on render.
 */
export function validateProposalBlocks(value: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(value)) return ["Template must be a list of blocks"];
  if (value.length === 0) return ["Template has no blocks"];
  const ids = new Set<string>();
  value.forEach((raw, i) => {
    const b = raw as Partial<ProposalBlock>;
    const at = `block ${i + 1}`;
    if (!b || typeof b !== "object") return problems.push(`${at}: not an object`);
    if (typeof b.id !== "string" || !b.id.trim()) problems.push(`${at}: missing id`);
    else if (ids.has(b.id)) problems.push(`${at}: duplicate id "${b.id}"`);
    else ids.add(b.id);
    if (typeof b.visible !== "boolean") problems.push(`${at}: visible must be true or false`);
    const isDynamic = b.dynamic !== undefined;
    if (isDynamic && !DYNAMIC_BLOCK_TYPES.includes(b.dynamic as DynamicBlockType))
      problems.push(`${at}: unknown dynamic type "${b.dynamic}"`);
    if (!isDynamic) {
      if (!Array.isArray(b.content) || b.content.length === 0)
        problems.push(`${at}: a static block needs content`);
      else
        b.content.forEach((p, j) => {
          const where = `${at} part ${j + 1}`;
          if (!["paragraph", "bullets", "numbered"].includes(p?.format))
            problems.push(`${where}: unknown format "${p?.format}"`);
          else if (p.format === "paragraph") {
            if (!p.text?.trim() && !p.label?.trim()) problems.push(`${where}: empty paragraph`);
          } else if (!Array.isArray(p.items) || p.items.length === 0)
            problems.push(`${where}: list has no items`);
        });
    }
  });
  return problems;
}

/** A stored value that is usable, else the default — render must never fail on bad config. */
export function blocksOrDefault(value: unknown): ProposalBlock[] {
  return validateProposalBlocks(value).length === 0
    ? (value as ProposalBlock[])
    : DEFAULT_PROPOSAL_BLOCKS;
}
