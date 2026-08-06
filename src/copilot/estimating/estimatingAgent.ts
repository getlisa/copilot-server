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
 *  - described problem → KB lookup: single match → agent-suggested proposal;
 *    several/none → follow-up question, capped at 2, then fall back to asking
 *    the technician to name the material directly
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

interface AgentOutput {
  operations: AgentOp[];
  reply: string;
  isFollowUpQuestion: boolean;
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
    },
    required: ["operations", "reply", "isFollowUpQuestion"],
  },
};

const SYSTEM_PROMPT = `You are the Estimating Agent for a field-service technician building a quote by talking through a job. Parse each utterance into explicit line-item operations against the CURRENT LINE ITEMS you are given. You never price anything — pricing happens downstream against the org's pricebook.

Rules:
- Multiple items in one statement → one add_item per item.
- If the technician corrects/reverses themself within the statement ("actually scratch that, I don't need the panel, I need two panels"), emit only the corrected final intent.
- Changing quantity/size/type of something already in the quote → update_item on that row (never add a duplicate).
- Removing something → remove_item with its itemId.
- If a spoken reference ("that one", "the panel") could match MORE THAN ONE existing line item, NEVER guess: emit ambiguous_reference with action ("remove" or "update"), candidateItemIds, referenceText, and any pending change fields (description/quantity/unit). Do not also emit the underlying op.
- Never invent a quantity. Item named without one → add_item with quantity null.
- Units: keep what the technician said (ft, EA, etc.), else null.

Described problems (no material named): check the KNOWLEDGE BASE ENTRIES provided.
- Exactly one entry clearly fits → kb_proposal with its kbEntryId (quantity from the entry unless the technician said one). In your reply, make clear this is a suggestion they must confirm.
- Several entries fit similarly, or none clearly → ask ONE short follow-up question (isFollowUpQuestion true, no operations).
- You will be told how many follow-ups were already asked for the current problem. If 2 were already asked, do NOT ask another: ask them to name the material directly (isFollowUpQuestion false).
- If the knowledge base list is EMPTY, say you don't have a suggestion for this one yet and ask them to name the material or item they need (isFollowUpQuestion false).

Reply: one or two short sentences confirming what changed, in plain language. Point to the Invoice tab for quantities, prices, and anything flagged. If the input is small talk or empty of intent, reply briefly with no operations.`;

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
}

export async function runEstimatingTurn(opts: {
  quoteId: string;
  companyId: number;
  utterance: string;
  history: EstimateTurn[];
  followUpsAsked: number;
}): Promise<AgentTurnResult> {
  const [items, kbEntries, pricebook] = await Promise.all([
    prisma.quoteLineItem.findMany({
      where: { quoteId: opts.quoteId },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.kbEntry.findMany({ where: { companyId: opts.companyId } }),
    prisma.pricebookItem.findMany({ where: { companyId: opts.companyId } }),
  ]);

  const { raw } = await callStructured({
    system: SYSTEM_PROMPT,
    userContent: buildTurnContext(
      items,
      kbEntries,
      opts.followUpsAsked,
      opts.utterance
    ),
    history: opts.history,
    jsonSchema: TURN_JSON_SCHEMA,
  });

  const output = raw as AgentOutput | null;
  if (!output || !Array.isArray(output.operations)) {
    logger.warn("Estimating agent returned unparseable output", { raw });
    return {
      reply: "Sorry, I didn't catch that — please repeat it or type it instead.",
      isFollowUpQuestion: false,
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
  };
}
