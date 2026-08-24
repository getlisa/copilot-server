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
 * Companies with no stored template keep using the original hardcoded builders, so their
 * output is unchanged byte-for-byte. DEFAULT_PROPOSAL_BLOCKS mirrors that hardcoded proposal
 * and is what the admin editor starts from.
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
 * The current hardcoded proposal, expressed as blocks. A company's stored template starts as
 * a copy of this, so "customize our proposal" begins from exactly what they get today rather
 * than from a blank page.
 *
 * Kept in sync with proposalDocx.ts by check-proposal-template.ts, which asserts the static
 * lists here still match the STATIC_* constants the default builder uses.
 */
export const DEFAULT_PROPOSAL_BLOCKS: ProposalBlock[] = [
  // Split on purpose (2026-08-24): logo, contact line and title are independently ordered,
  // hidden and styled. The title is STATIC — "Bid Proposal" is just wording, and a company
  // may call theirs "Estimate"; the contact line stays dynamic because joining only the
  // configured values ("phone | email", either alone, or nothing) is logic, not text.
  { id: "logo", visible: true, dynamic: "logo" },
  {
    id: "contact-line",
    visible: true,
    dynamic: "contactLine",
    style: { align: "center", fontSize: 9, color: "666666" },
  },
  {
    id: "title",
    visible: true,
    style: { align: "center", bold: true, fontSize: 16 },
    content: [{ format: "paragraph", text: "Bid Proposal" }],
  },
  { id: "project", visible: true, dynamic: "projectBlock" },
  {
    id: "general-scope",
    heading: "GENERAL SCOPE",
    visible: true,
    content: [
      {
        format: "paragraph",
        text:
          '{{companyName}} ("Contractor") shall furnish all labor, materials, equipment, and ' +
          "supervision necessary to complete the work described herein in accordance with all " +
          "applicable code requirements, and all state and local codes and regulations.",
      },
    ],
  },
  {
    id: "scope-of-work",
    heading: "DETAILED SCOPE OF WORK",
    visible: true,
    dynamic: "scopeOfWork",
  },
  {
    id: "exclusions",
    heading: "EXCLUSIONS",
    visible: true,
    content: [
      {
        format: "paragraph",
        text: "The following items are specifically EXCLUDED from this scope of work:",
      },
      {
        format: "numbered",
        items: [
          "Patching or repair of walls, ceilings, or finishes of any kind",
          "Painting or finishing of any kind",
          "Any additional work not included in this bid — such work will be quoted separately upon discovery",
          "Moving of materials or obstructions impeding the work — work area must be clear and accessible prior to Contractor commencing work",
        ],
      },
    ],
  },
  {
    id: "general-conditions",
    heading: "GENERAL CONDITIONS",
    visible: true,
    content: [
      {
        format: "bullets",
        label: "Coordination:",
        items: [
          "Contractor will coordinate work schedule with the customer to minimize disruption",
          "Contractor will provide advance notice before any work requiring power outages",
        ],
      },
      {
        format: "bullets",
        label: "Code Compliance:",
        items: [
          "All work shall comply with the current National Electrical Code (NEC)",
          "All work shall comply with applicable state electrical code requirements",
          "All work shall comply with local jurisdiction amendments and requirements",
        ],
      },
    ],
  },
  {
    id: "assumptions",
    heading: "ASSUMPTIONS",
    visible: true,
    content: [
      {
        format: "paragraph",
        text: "This scope of work is based on the following assumptions:",
      },
      {
        format: "numbered",
        items: [
          "Work area is accessible and clear of materials or obstructions prior to Contractor's arrival",
          "Site conditions are as represented during initial assessment",
          "Work will be performed during normal business hours (Monday–Friday, 7:00 AM – 5:00 PM)",
          "This proposal assumes no bonding requirements. If bonds are required, the cost will be added to the contract price.",
        ],
      },
    ],
  },
  { id: "cost", visible: true, dynamic: "costSummary" },
  {
    id: "payment-terms",
    visible: true,
    content: [
      {
        format: "paragraph",
        label: "PAYMENT TERMS:",
        text: "Payment due in full upon project completion.",
      },
    ],
  },
  {
    id: "validity",
    visible: true,
    style: { italic: true, fontSize: 8, color: "666666" },
    content: [
      {
        format: "paragraph",
        text:
          "*Due to potential fluctuations in material costs, this bid is valid for 45 days from " +
          "the date of issuance. If not accepted within this period, a revised proposal may be " +
          "required to reflect current market conditions.",
      },
    ],
  },
    // Static on purpose, unlike the other generated sections: everything it shows is
  // expressible as tokens, and making it "their text" is what lets an admin reword it
  // (bug report 2026-08-24). A paragraph whose tokens all fill to empty is skipped at
  // render time, so a company without a licence number prints no dangling label.
  {
    id: "prepared-by",
    heading: "PREPARED BY:",
    visible: true,
    content: [
      { format: "paragraph", text: "{{companyName}}", style: { bold: true } },
      { format: "paragraph", text: "{{companyPhone}}" },
      { format: "paragraph", text: "{{companyEmail}}" },
      { format: "paragraph", label: "Contractor License:", text: "{{licenseNumber}}" },
    ],
  },
  { id: "photos", heading: "PROJECT PHOTOS", visible: true, dynamic: "photos" },
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
