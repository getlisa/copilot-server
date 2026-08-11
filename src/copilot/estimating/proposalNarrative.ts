import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { callStructured } from "../estimate/estimateService";
import type { LineItemDto } from "./quoteDto";

/**
 * Proposal narrative: turns the estimate chat + line items into the bid-proposal
 * prose — numbered scope-of-work sections describing the WORK to be performed
 * (not the materials list) and job-specific assumptions. Generated on demand at
 * DOCX time; callers fall back to a materials-list scope when this returns null.
 */

export interface ScopeSection {
  title: string;
  bullets: string[];
}

export interface ProposalNarrative {
  scopeSections: ScopeSection[];
  assumptions: string[];
}

const NARRATIVE_JSON_SCHEMA = {
  name: "proposal_narrative",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      scopeSections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            bullets: { type: "array", items: { type: "string" } },
          },
          required: ["title", "bullets"],
        },
      },
      assumptions: { type: "array", items: { type: "string" } },
    },
    required: ["scopeSections", "assumptions"],
  },
};

const SYSTEM_PROMPT = `You write the scope-of-work section of professional contractor bid proposals for technical field-service trades (electrical, HVAC, plumbing, fire protection).

You are given the technician's estimate conversation and the final material/line-item list. Produce:

1. scopeSections: 1-4 numbered sections describing the WORK the contractor will perform — not a materials list. Each section has:
   - title: a short ALL-CAPS heading naming the work area, e.g. "HALLWAY WIRING REPAIR – LIGHTING & SWITCHING" (do NOT include a number; numbering is added later)
   - bullets: 3-8 action statements of the tasks, written like a contractor's proposal: what will be repaired/installed/replaced, access work required (cutting, removal), terminations and connections, and always end with testing/verification of proper operation. Example style: "Install new junction box at required location", "Complete all terminations and connections", "Test lighting and switching and verify proper operation upon completion".

2. assumptions: 4-7 job-specific assumptions this scope is based on. Start with assumptions specific to THIS job (access to the affected areas, issues being isolated as described, conditions matching what was discussed), then always include these standard ones:
   - "Site conditions are as represented during initial assessment"
   - "Work will be performed during normal business hours (Monday–Friday, 7:00 AM – 5:00 PM)"
   - "This proposal assumes no bonding requirements. If bonds are required, the cost will be added to the contract price."

Ground everything in what was actually discussed — do not invent work that was never mentioned. The materials list tells you what is being installed; the conversation tells you why and where.`;

export async function generateProposalNarrative(opts: {
  conversationId: string;
  lineItems: LineItemDto[];
}): Promise<ProposalNarrative | null> {
  try {
    const messages = await prisma.message.findMany({
      where: { conversationId: opts.conversationId },
      orderBy: { createdAt: "asc" },
      select: { senderType: true, content: true },
    });
    const transcript = messages
      .filter((m) => (m.senderType === "USER" || m.senderType === "AI") && m.content?.trim())
      .slice(-40)
      .map((m) => `${m.senderType === "USER" ? "Technician" : "Assistant"}: ${m.content}`)
      .join("\n");
    const items = opts.lineItems
      .map(
        (li) =>
          `- ${li.description}${li.quantity != null ? ` — ${li.quantity}${li.unit ? " " + li.unit : ""}` : ""}`
      )
      .join("\n");

    const { raw } = await callStructured({
      system: SYSTEM_PROMPT,
      userContent: `CONVERSATION:\n${transcript || "(no conversation recorded)"}\n\nFINAL LINE ITEMS:\n${items || "(none)"}`,
      jsonSchema: NARRATIVE_JSON_SCHEMA,
    });

    const out = raw as ProposalNarrative | null;
    const sections = (out?.scopeSections ?? []).filter(
      (s) => s?.title?.trim() && Array.isArray(s.bullets) && s.bullets.length > 0
    );
    const assumptions = (out?.assumptions ?? []).filter((a) => typeof a === "string" && a.trim());
    if (sections.length === 0) return null;
    return { scopeSections: sections, assumptions };
  } catch (err) {
    logger.warn("Proposal narrative generation failed; falling back to materials list", {
      conversationId: opts.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
