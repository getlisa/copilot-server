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
  /** Job-specific EXCLUSIONS; always includes the standard boilerplate set. */
  exclusions: string[];
  /** Coordination bullets appropriate to THIS job and customer type. */
  coordination: string[];
  /** Header fields recovered from the conversation; null when never mentioned. */
  project: {
    title: string | null;
    customerName: string | null;
    siteAddress: string | null;
  };
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
      exclusions: { type: "array", items: { type: "string" } },
      coordination: { type: "array", items: { type: "string" } },
      project: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: ["string", "null"] },
          customerName: { type: ["string", "null"] },
          siteAddress: { type: ["string", "null"] },
        },
        required: ["title", "customerName", "siteAddress"],
      },
    },
    required: ["scopeSections", "assumptions", "exclusions", "coordination", "project"],
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

3. exclusions: what is specifically NOT included. Start with any trade-specific carve-outs stated or implied in the conversation (e.g. "VFD programming beyond basic setup and startup testing", "Security system repair, removal, or reinstallation", "Any work requiring lifts or special equipment", "Hazardous material abatement (asbestos, lead paint, etc.)"), then always include these standard ones:
   - "Patching or repair of walls, ceilings, or finishes of any kind"
   - "Painting or finishing of any kind"
   - "Any additional work not included in this bid — such work will be quoted separately upon discovery"
   - "Moving of materials or obstructions impeding the work — work area must be clear and accessible prior to Contractor commencing work"

4. coordination: 2-4 coordination bullets that are TRUE FOR THIS JOB. Call the customer "homeowner" only on residential work; commercial/industrial customers are "customer" and coordination is about minimizing disruption to site operations. State power-outage expectations at the duration actually discussed (a full service changeout is a multi-hour outage — never call it "brief" unless it is), and mention access work (wall/ceiling penetrations, shiplap or sheetrock removal, area shutdowns) only when the scope actually involves it.

5. project: the header fields, recovered from the conversation. title is a short project name like "Residential Rewire & Panel Replacement" or "Lighting Contactor Replacement" — it names the WORK only, and must never contain the customer's name, address, or phone number (it is reused in the email subject and greeting line, where an address reads as a mail-merge mistake; the address has its own field). customerName and siteAddress exactly as the technician stated them. Use null for anything never mentioned — never invent a name or address.

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
          `- ${li.optionGroup ? `[${li.optionGroup}] ` : ""}${li.description}${li.quantity != null ? ` — ${li.quantity}${li.unit ? " " + li.unit : ""}` : ""}`
      )
      .join("\n");

    const { raw } = await callStructured({
      system: SYSTEM_PROMPT,
      userContent: `CONVERSATION:\n${transcript || "(no conversation recorded)"}\n\nFINAL LINE ITEMS:\n${items || "(none)"}`,
      jsonSchema: NARRATIVE_JSON_SCHEMA,
    });

    const out = raw as ProposalNarrative | null;
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s.trim()) : [];
    const sections = (out?.scopeSections ?? []).filter(
      (s) => s?.title?.trim() && Array.isArray(s.bullets) && s.bullets.length > 0
    );
    if (sections.length === 0) return null;
    const field = (v: unknown): string | null =>
      typeof v === "string" && v.trim() ? v.trim() : null;
    return {
      scopeSections: sections,
      assumptions: strings(out?.assumptions),
      exclusions: strings(out?.exclusions),
      coordination: strings(out?.coordination),
      project: {
        title: field(out?.project?.title),
        customerName: field(out?.project?.customerName),
        siteAddress: field(out?.project?.siteAddress),
      },
    };
  } catch (err) {
    logger.warn("Proposal narrative generation failed; falling back to materials list", {
      conversationId: opts.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
