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
 * Match a ZenTrades job type ("Annual Fire Sprinkler Inspection") against the company's
 * template names ("NFPA 25 Inspection Proposal"), so a ZT-seeded quote starts on the right
 * design without the chat having to ask. Pure and deliberately dumb — no model call:
 * an admin must be able to predict which template a job type lands on from the names alone.
 *
 * Rules, in order: containment either way wins (longest contained name first); otherwise the
 * template sharing the most meaningful words wins; a TIE means ambiguity and matches nothing —
 * a wrong template on a customer document is worse than the chat asking.
 */
export function matchTemplateToJobType<T extends { id: number; name: string }>(
  templates: T[],
  jobType: string | null | undefined
): T | null {
  if (!jobType?.trim() || templates.length === 0) return null;
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      // Words that appear in template names without saying anything about the JOB.
      .filter((w) => w && !["proposal", "template", "default", "new", "the", "a", "of"].includes(w));
  const job = words(jobType);
  if (job.length === 0) return null;
  const jobSet = new Set(job);
  const scored = templates
    .map((t) => {
      const name = words(t.name);
      if (name.length === 0) return { t, score: 0 };
      const nameStr = name.join(" ");
      const jobStr = job.join(" ");
      // Containment outranks any token count; longer contained text = more specific match.
      if (nameStr === jobStr || jobStr.includes(nameStr) || nameStr.includes(jobStr))
        return { t, score: 1000 + Math.min(nameStr.length, jobStr.length) };
      return { t, score: name.filter((w) => jobSet.has(w)).length };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return scored[0].t;
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
