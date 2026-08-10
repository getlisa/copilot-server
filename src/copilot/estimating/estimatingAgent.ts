import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { callStructured, EstimateTurn } from "../estimate/estimateService";
import { matchPricebook } from "./pricebookMatch";
import { QuoteLineItem, PricebookItem } from "@prisma/client";

/**
 * Estimating Agent turn: one structured LLM call that parses a technician's
 * utterance into explicit line-item OPERATIONS, which the server then applies
 * to persisted rows. The model never touches prices — pricing happens here,
 * server-side, against the org's pricebook (or not at all → unmatched flag).
 *
 * PRD rules encoded:
 *  - multi-item statements → one add op per item
 *  - self-corrections → only the corrected intent survives
 *  - quantity/description changes update the existing row, never duplicate
 *  - a reference matching >1 existing items → ambiguous op (tap-to-select, no guessing)
 *  - missing quantity stays null — never invented
 *  - described problem/job → KB lookup: single match → agent-suggested proposal;
 *    otherwise the agent scopes it from its own trade knowledge: clarify needs
 *    (follow-ups capped at 2) → propose an itemized list → add on confirmation
 */

interface AgentOp {
  type:
    | "add_item"
    | "update_item"
    | "remove_item"
    | "ambiguous_reference"
    | "kb_proposal";
  itemId: string | null;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  action: "remove" | "update" | null;
  candidateItemIds: string[] | null;
  referenceText: string | null;
  kbEntryId: number | null;
}

interface AgentQuestion {
  question: string;
  options: string[];
}

interface AgentOutput {
  operations: AgentOp[];
  reply: string;
  isFollowUpQuestion: boolean;
  questions: AgentQuestion[] | null;
}

const nullable = (t: string) => ({ type: [t, "null"] });

const TURN_JSON_SCHEMA = {
  name: "estimating_turn",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      operations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: {
              type: "string",
              enum: [
                "add_item",
                "update_item",
                "remove_item",
                "ambiguous_reference",
                "kb_proposal",
              ],
            },
            itemId: nullable("string"),
            description: nullable("string"),
            quantity: nullable("number"),
            unit: nullable("string"),
            action: { type: ["string", "null"], enum: ["remove", "update", null] },
            candidateItemIds: {
              type: ["array", "null"],
              items: { type: "string" },
            },
            referenceText: nullable("string"),
            kbEntryId: nullable("integer"),
          },
          required: [
            "type",
            "itemId",
            "description",
            "quantity",
            "unit",
            "action",
            "candidateItemIds",
            "referenceText",
            "kbEntryId",
          ],
        },
      },
      reply: { type: "string" },
      isFollowUpQuestion: { type: "boolean" },
      questions: {
        type: ["array", "null"],
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: { type: "string" },
            options: { type: "array", items: { type: "string" } },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["operations", "reply", "isFollowUpQuestion", "questions"],
  },
};

const SYSTEM_PROMPT = `You are Clara, an expert estimating assistant for field-service technicians working in HVAC, plumbing, fire inspection, fire protection, electrical, and similar technical trades. You help build a quote by talking through a job: parse each utterance into explicit line-item operations against the CURRENT LINE ITEMS you are given. You never price anything — pricing happens downstream against the org's pricebook.

Trade expertise: you know the codes and standards that govern this work — NFPA for fire protection (e.g. NFPA 13 sprinkler installation, NFPA 101 life safety), NEC for electrical, ICC codes for building/plumbing, ASHRAE for HVAC. When scoping a described job, briefly share the considerations and standards that matter (design requirements, permits, licensed-contractor requirements, inspections) — but always steer back to building the estimate: that expert context accompanies your clarifying questions and item proposals, it never replaces them. If a query is entirely outside these trades, politely say you're specialized for technical field-service trades.

Rules:
- Multiple items in one statement → one add_item per item.
- If the technician corrects/reverses themself within the statement ("actually scratch that, I don't need the panel, I need two panels"), emit only the corrected final intent.
- Changing quantity/size/type of something already in the quote → update_item on that row (never add a duplicate).
- Removing something → remove_item with its itemId.
- If a spoken reference ("that one", "the panel") could match MORE THAN ONE existing line item, NEVER guess: emit ambiguous_reference with action ("remove" or "update"), candidateItemIds, referenceText, and any pending change fields (description/quantity/unit). Do not also emit the underlying op.
- Never invent a quantity. Item named without one → add_item with quantity null.
- Units: keep what the technician said (ft, EA, etc.), else null.
- The technician may attach photos. Use them to identify equipment, materials, model/size details, and site conditions when parsing items or scoping a job — but still never invent quantities or prices from a photo alone.

Whenever you ask ANY clarifying question (isFollowUpQuestion true), also populate the questions array with the same question(s) as multiple-choice: 2-5 short, likely answer options each. Set questions to null when you are not asking anything.

Described problems or jobs (no specific material named, e.g. "need to install an EV charger"):
- Check the KNOWLEDGE BASE ENTRIES first. Exactly one entry clearly fits → kb_proposal with its kbEntryId (quantity from the entry unless the technician said one). In your reply, make clear this is a suggestion they must confirm.
- Otherwise, use your own trade knowledge to scope the job. Follow this sequence:
  1. CLARIFY: if details that materially change the equipment list are unknown (e.g. for an EV charger: level/amperage, distance from the panel, indoor or outdoor, panel capacity), ask in ONE round (isFollowUpQuestion true, no operations): populate the questions array with 1-4 short questions, each with 2-5 likely answer options covering the common cases (the UI adds an "Other" free-text box automatically). Keep the reply itself to a brief lead-in with any expert context. You will be told how many follow-up rounds were already asked; after 2, stop asking and proceed with reasonable assumptions, stating them.
  2. PROPOSE: reply with a clearly itemized list of the equipment/materials needed — each with a quantity and unit where sensible — and ask the technician to confirm before you add anything (isFollowUpQuestion false, NO operations yet).
  3. CONFIRM & ADD: when the technician confirms (or confirms with changes), emit one add_item per agreed item with its quantity and unit. If they adjust the list, apply their adjustments.
- Never add proposed items to the quote before the technician confirms them in chat.

Reply: respond like a friendly, knowledgeable tradesperson — conversational and helpful, not robotic. Confirm what changed in plain language; when you added or changed multiple items, list them as short markdown bullets. When scoping a job, lead with a sentence or two of relevant expert context (key requirements, applicable standards) before your question or proposed list. Point to the Invoice tab for quantities, prices, and anything flagged. Keep replies concise enough to be read aloud — expert context is a couple of sentences, not a lecture. If the input is small talk or empty of intent, reply naturally with no operations.`;

interface KbEntryLite {
  id: number;
  problem: string;
  materialDescription: string;
  pricebookCode: string | null;
  defaultQuantity: unknown;
  unit: string | null;
}

function buildTurnContext(
  items: QuoteLineItem[],
  kbEntries: KbEntryLite[],
  followUpsAsked: number,
  utterance: string
): string {
  const itemLines =
    items.length === 0
      ? "(none yet)"
      : items
          .map(
            (i) =>
              `- id=${i.id} | ${i.description} | qty=${i.quantity ?? "MISSING"}${i.unit ? " " + i.unit : ""}${i.agentSuggested ? " | agent-suggested, unconfirmed" : ""}${i.ambiguousAction ? " | pending ambiguous reference" : ""}`
          )
          .join("\n");
  const kbLines =
    kbEntries.length === 0
      ? "(empty — no prior data)"
      : kbEntries
          .map(
            (k) =>
              `- kbEntryId=${k.id} | problem: ${k.problem} | material: ${k.materialDescription} | default qty: ${k.defaultQuantity}${k.unit ? " " + k.unit : ""}`
          )
          .join("\n");
  return `CURRENT LINE ITEMS:
${itemLines}

KNOWLEDGE BASE ENTRIES (problem → material):
${kbLines}

FOLLOW-UPS ALREADY ASKED FOR THE CURRENT PROBLEM: ${followUpsAsked} of 2 max.

TECHNICIAN SAID:
${utterance}`;
}

/** Count the current streak of AI follow-up questions (broken by any non-follow-up AI message). */
export function countRecentFollowUps(
  messages: { senderType: string; metadata: unknown }[]
): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.senderType !== "AI") continue;
    if ((m.metadata as any)?.isFollowUpQuestion === true) count++;
    else break;
  }
  return count;
}

export interface AgentTurnResult {
  reply: string;
  isFollowUpQuestion: boolean;
  /** Clarifying questions as multiple-choice (rendered with an "Other" box in the UI). */
  questions: AgentQuestion[];
}

export async function runEstimatingTurn(opts: {
  quoteId: string;
  companyId: number;
  utterance: string;
  history: EstimateTurn[];
  followUpsAsked: number;
  /** Presigned URLs of photos attached to this turn (vision input). */
  imageUrls?: string[];
}): Promise<AgentTurnResult> {
  const [items, kbEntries, pricebook] = await Promise.all([
    prisma.quoteLineItem.findMany({
      where: { quoteId: opts.quoteId },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.kbEntry.findMany({ where: { companyId: opts.companyId } }),
    prisma.pricebookItem.findMany({ where: { companyId: opts.companyId } }),
  ]);

  const turnContext = buildTurnContext(items, kbEntries, opts.followUpsAsked, opts.utterance);
  const { raw } = await callStructured({
    system: SYSTEM_PROMPT,
    userContent: opts.imageUrls?.length
      ? [
          { type: "text", text: turnContext },
          ...opts.imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
        ]
      : turnContext,
    history: opts.history,
    jsonSchema: TURN_JSON_SCHEMA,
  });

  const output = raw as AgentOutput | null;
  if (!output || !Array.isArray(output.operations)) {
    logger.warn("Estimating agent returned unparseable output", { raw });
    return {
      reply: "Sorry, I didn't catch that — please repeat it or type it instead.",
      isFollowUpQuestion: false,
      questions: [],
    };
  }

  const matchable = pricebook.map((p) => ({
    id: p.id,
    code: p.code,
    description: p.description,
    unit: p.unit,
    unitPrice: Number(p.unitPrice),
    synonyms: p.synonyms,
  }));
  const byCode = new Map(matchable.map((p) => [p.code, p]));
  const validIds = new Set(items.map((i) => i.id));
  let nextSort =
    items.length > 0 ? Math.max(...items.map((i) => i.sortOrder)) + 1 : 0;

  const priceFields = (description: string, explicitCode?: string | null) => {
    const match =
      (explicitCode ? byCode.get(explicitCode) : undefined) ??
      matchPricebook(description, matchable);
    return match
      ? {
          pricebookCode: match.code,
          unitPrice: match.unitPrice,
          unit: match.unit,
        }
      : { pricebookCode: null, unitPrice: null, unit: null };
  };

  for (const op of output.operations) {
    try {
      switch (op.type) {
        case "add_item": {
          if (!op.description) break;
          const priced = priceFields(op.description);
          await prisma.quoteLineItem.create({
            data: {
              quoteId: opts.quoteId,
              description: op.description,
              quantity: op.quantity,
              unit: op.unit ?? priced.unit,
              unitPrice: priced.unitPrice,
              pricebookCode: priced.pricebookCode,
              sortOrder: nextSort++,
            },
          });
          break;
        }
        case "kb_proposal": {
          const kb = kbEntries.find((k) => k.id === op.kbEntryId);
          if (!kb) break;
          const description = op.description ?? kb.materialDescription;
          const priced = priceFields(description, kb.pricebookCode);
          await prisma.quoteLineItem.create({
            data: {
              quoteId: opts.quoteId,
              description,
              quantity: op.quantity ?? kb.defaultQuantity,
              unit: op.unit ?? kb.unit ?? priced.unit,
              unitPrice: priced.unitPrice,
              pricebookCode: priced.pricebookCode,
              agentSuggested: true,
              sortOrder: nextSort++,
            },
          });
          break;
        }
        case "update_item": {
          if (!op.itemId || !validIds.has(op.itemId)) break;
          const existing = items.find((i) => i.id === op.itemId)!;
          const data: Record<string, unknown> = {};
          if (op.quantity != null) data.quantity = op.quantity;
          if (op.unit != null) data.unit = op.unit;
          if (op.description != null && op.description !== existing.description) {
            data.description = op.description;
            if (!existing.manuallyEdited) {
              const priced = priceFields(op.description);
              data.pricebookCode = priced.pricebookCode;
              data.unitPrice = priced.unitPrice;
              if (priced.unit && op.unit == null) data.unit = priced.unit;
            }
          }
          if (Object.keys(data).length > 0)
            await prisma.quoteLineItem.update({
              where: { id: op.itemId },
              data,
            });
          break;
        }
        case "remove_item": {
          if (!op.itemId || !validIds.has(op.itemId)) break;
          await prisma.quoteLineItem.delete({ where: { id: op.itemId } });
          break;
        }
        case "ambiguous_reference": {
          const candidates = (op.candidateItemIds ?? []).filter((id) =>
            validIds.has(id)
          );
          if (candidates.length < 2) break; // not actually ambiguous
          await prisma.quoteLineItem.create({
            data: {
              quoteId: opts.quoteId,
              description: op.referenceText ?? "(ambiguous reference)",
              sortOrder: nextSort++,
              ambiguousAction: {
                action: op.action ?? "remove",
                candidateItemIds: candidates,
                referenceText: op.referenceText ?? "",
                fields: {
                  ...(op.description != null && { description: op.description }),
                  ...(op.quantity != null && { quantity: op.quantity }),
                  ...(op.unit != null && { unit: op.unit }),
                },
              },
            },
          });
          break;
        }
      }
    } catch (err) {
      logger.error("Estimating agent op failed", {
        op,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    reply: output.reply,
    isFollowUpQuestion: output.isFollowUpQuestion === true,
    questions: (output.questions ?? []).filter(
      (q) =>
        q &&
        typeof q.question === "string" &&
        q.question.trim() &&
        Array.isArray(q.options) &&
        q.options.length > 0
    ),
  };
}
