import prisma from "./prisma";

/**
 * Proposal template library (template-library PRD, Feature B).
 *
 * Render resolution chain, in order: the quote's chosen template → the company's default
 * template → the legacy companies.proposal_template column (read-fallback for one release,
 * dropped after cutover) → null, which every renderer already treats as the built-in
 * DEFAULT_PROPOSAL_BLOCKS. A deleted or foreign template id falls through the chain — a
 * proposal render can never fail because of a template.
 */

/** The chain itself, pure so check-proposal-templates.ts can assert it without a DB. */
export function pickBlocks(sources: {
  /** Blocks of the quote's chosen template row, if that row still exists in this company. */
  chosen: unknown | null;
  /** Blocks of the company's is_default template row, if one exists. */
  companyDefault: unknown | null;
  /** The legacy companies.proposal_template column value. */
  legacy: unknown | null;
}): unknown {
  return sources.chosen ?? sources.companyDefault ?? sources.legacy ?? null;
}

/** Resolve the blocks a quote's proposal should render with. */
export async function resolveProposalBlocks(
  companyId: number,
  proposalTemplateId: number | null | undefined
): Promise<unknown> {
  // companyId is in every where-clause: a stale id pointing into another company's library
  // must fall through, not leak a foreign design.
  const [chosen, companyDefault, company] = await Promise.all([
    proposalTemplateId != null
      ? prisma.proposalTemplate.findFirst({
          where: { id: proposalTemplateId, companyId },
          select: { blocks: true },
        })
      : Promise.resolve(null),
    prisma.proposalTemplate.findFirst({
      where: { companyId, isDefault: true },
      select: { blocks: true },
    }),
    prisma.companies.findUnique({
      where: { id: companyId },
      select: { proposal_template: true },
    }),
  ]);
  return pickBlocks({
    chosen: chosen?.blocks ?? null,
    companyDefault: companyDefault?.blocks ?? null,
    legacy: company?.proposal_template ?? null,
  });
}

/**
 * The template names offered in the chat ask. The ask only happens with 2+ templates — with
 * 0 or 1 the default (or the single design) applies silently, exactly as today.
 */
export async function listProposalTemplateChoices(
  companyId: number
): Promise<{ id: number; name: string }[]> {
  return prisma.proposalTemplate.findMany({
    where: { companyId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}
