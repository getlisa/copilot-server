import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { callStructured, EstimateTurn } from "../estimate/estimateService";
import { matchPricebook } from "./pricebookMatch";
import { packAwareQuantity } from "./packMath";
import { enqueueResolve } from "./homeDepotCatalog";
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
  /**
   * Terse, catalog-shaped name for the PART behind this line — the thing pricing matches on.
   * `description` stays human-readable for the quote; this is what a supplier would call it.
   *
   * Added because prose descriptions are unmatchable by construction. In three consecutive
   * real quotes, 11 of 13 lines read like "Subpanel or load-management solution for EV
   * circuit capacity" or "Make-safe and test restored lighting/switch circuit" — scope, not
   * products. No catalog stocks those and no threshold can match them, so every line came
   * back unpriced. The model already knows it means "6 AWG THHN copper wire"; it just was
   * never asked.
   */
  searchTerm: string | null;
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
            searchTerm: nullable("string"),
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
            "searchTerm",
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
- ONE PURCHASABLE PRODUCT PER LINE: never bundle products into one item ("EMT fittings", "boxes and covers", "misc hardware"). Split into the actual parts — e.g. "EMT fittings" for a 1/2 in run → separate lines for "1/2 in EMT set screw connector", "1/2 in EMT coupling", "1/2 in EMT strap".
- description is a short product name with its size/spec ("1/2 in EMT conduit", "14 AWG THHN stranded wire"), NOT a sentence of scope ("EMT conduit for new lighting control run"). Put the scope/purpose in your reply, not on the line.
- If the technician corrects/reverses themself within the statement ("actually scratch that, I don't need the panel, I need two panels"), emit only the corrected final intent.
- Changing quantity/size/type of something already in the quote → update_item on that row (never add a duplicate).
- Removing something → remove_item with its itemId.
- If a spoken reference ("that one", "the panel") could match MORE THAN ONE existing line item, NEVER guess: emit ambiguous_reference with action ("remove" or "update"), candidateItemIds, referenceText, and any pending change fields (description/quantity/unit). Do not also emit the underlying op.
- Never invent a quantity. Item named without one → add_item with quantity null.
- CURRENT LINE ITEMS may include product details for priced lines (brand, price, rating, link). If the technician asks for a product link, price, brand or rating, answer from those details with NO operations. Reproduce a link EXACTLY as given, character for character — never shorten, rewrite or guess a URL, and never invent one for a line that has none. If a line has no product details, say it isn't priced from the catalog yet rather than guessing.
- EVERY add_item and kb_proposal MUST carry a searchTerm: the terse, catalog-shaped name of the PART, as a supplier would list it. description stays readable for the customer; searchTerm is what pricing matches on, so it decides whether the line gets a price at all.
  - Name the product and its rating/size ONLY. No verbs, no scope, no conditionals, no "as needed", no "if required", no "and miscellaneous".
  - Include the spec that identifies it: amperage, gauge, size, voltage, capacity.
  - Inherit the spec from job context: accessories take the size of what they attach to — a connector for a 1/2 in EMT run → "1/2 in EMT set screw connector", a cover for a 4 in square box → "4 in square box flat cover".
  - "Branch circuit wiring repair/replacement"                     → searchTerm "12 AWG THHN wire"
  - "EV charger circuit wiring"                                    → searchTerm "6 AWG THHN wire"
  - "60A 2-pole breaker for the EV circuit"                        → searchTerm "60A double pole circuit breaker"
  - "Accessible junction box(es) and cover(s), as needed"          → searchTerm "4 in square junction box"
  - "Wire connectors / repair consumables, as needed"              → searchTerm "wire connectors"
  - "Conduit for EV charger circuit"                               → searchTerm "3/4 in EMT conduit"
  - If a line is genuinely pure labor, diagnosis, or testing with no material to buy, set searchTerm null — it is not a purchasable part and must not be priced as one.
- Units: keep what the technician said (ft, EA, etc.), else null.
- The technician may attach photos. Use them to identify equipment, materials, model/size details, and site conditions when parsing items or scoping a job — but still never invent quantities or prices from a photo alone.

Whenever you ask ANY clarifying question (isFollowUpQuestion true), put the question(s) ONLY in the questions array as multiple-choice: 2-5 short, likely answer options each. The UI renders that array as tappable options right below your reply, so NEVER write the questions themselves (or a list of them) in the reply text — the reply is one or two sentences of lead-in/expert context only, no question list, no "1." / bullets of questions. Set questions to null when you are not asking anything.

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
  utterance: string,
  /** Pricebook rows keyed by code, so priced lines can expose product link/brand/rating. */
  catalog?: Map<string, PricebookItem>
): string {
  // Product provenance is included so the agent can answer "what's the link / brand / price"
  // from context instead of guessing or web-searching. Keyed off the line's pricebookCode.
  const itemLines =
    items.length === 0
      ? "(none yet)"
      : items
          .map((i) => {
            const cat = i.pricebookCode ? catalog?.get(i.pricebookCode) : undefined;
            const product = cat
              ? ` | product: ${cat.brand ? cat.brand + " " : ""}${cat.description}` +
                ` | price: $${Number(cat.unitPrice)}/${cat.unit}` +
                (cat.packageQuantity != null && Number(cat.packageQuantity) > 1
                  ? ` | sold in packs of ${Number(cat.packageQuantity)} (quantity is rounded up to whole packs)`
                  : "") +
                (cat.rating != null ? ` | rating: ${Number(cat.rating)}` : "") +
                (cat.externalLink ? ` | link: ${cat.externalLink}` : "")
              : "";
            return (
              `- id=${i.id} | ${i.description} | qty=${i.quantity ?? "MISSING"}${i.unit ? " " + i.unit : ""}` +
              `${i.agentSuggested ? " | agent-suggested, unconfirmed" : ""}` +
              `${i.ambiguousAction ? " | pending ambiguous reference" : ""}${product}`
            );
          })
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

  const catalog = new Map(pricebook.map((p) => [p.code, p]));
  const turnContext = buildTurnContext(items, kbEntries, opts.followUpsAsked, opts.utterance, catalog);
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
    // Distinguishes the Home Depot cache from the company's own curated rows — see priceFields.
    source: p.source,
    // How many pieces the supplier sells at once. Carried through so a line's quantity can be
    // rounded up to whole packs — see packMath.
    packageQuantity: p.packageQuantity == null ? null : Number(p.packageQuantity),
  }));
  const byCode = new Map(matchable.map((p) => [p.code, p]));
  const validIds = new Set(items.map((i) => i.id));
  let nextSort =
    items.length > 0 ? Math.max(...items.map((i) => i.sortOrder)) + 1 : 0;

  // Home Depot is the price source for every material line. Rows already resolved from it
  // (source = HOME_DEPOT) are the cache: a hit there means the item was priced on some earlier
  // turn, so no API call is spent. MANUAL rows are the company's own curated book and act as
  // an immediate value while a first-time resolve runs in the background.
  const hdItems = matchable.filter((p) => p.source === "HOME_DEPOT");
  const manualItems = matchable.filter((p) => p.source !== "HOME_DEPOT");

  /**
   * `searchTerm` is the catalog-shaped part name and is tried FIRST; `description` is prose
   * written for the customer and matches poorly (measured: 11 of 13 lines across three real
   * quotes were unmatchable scope text). A null searchTerm on a labor/diagnostic line is a
   * deliberate signal that there is nothing to buy — no lookup, no price.
   *
   * Order: cached Home Depot row → (enqueue live Home Depot) → company book → blank.
   */
  const priceFields = (
    description: string,
    explicitCode?: string | null,
    searchTerm?: string | null
  ) => {
    const term = searchTerm?.trim() || null;
    const blank = {
      pricebookCode: null,
      unitPrice: null,
      unit: null,
      packageQuantity: null,
      resolveTerm: null,
    };

    // 0. An explicit KB code is a curated, exact identity mapping. It outranks any fuzzy
    //    match, and its line must not be re-resolved — the backfill would otherwise overwrite
    //    a human-chosen code with whatever the catalog returned for a generated searchTerm.
    const curated = explicitCode ? byCode.get(explicitCode) : undefined;
    if (curated) {
      return {
        pricebookCode: curated.code,
        unitPrice: curated.unitPrice,
        unit: curated.unit,
        packageQuantity: curated.packageQuantity,
        resolveTerm: null,
      };
    }

    // A null searchTerm means "not a purchasable part" (labour, diagnosis, testing). Honour it
    // literally: no lookup at all. Falling back to the prose description here priced labour
    // lines as parts — "Install 20A breaker" matched a $7.26 breaker and even attached its
    // product link, asserting that the labour line WAS that breaker.
    if (!term) return blank;

    const find = (items: typeof matchable) => matchPricebook(term, items);

    // 1. Already resolved from Home Depot for this company → reuse it, spend nothing.
    const cached = find(hdItems);
    if (cached) {
      return {
        pricebookCode: cached.code,
        unitPrice: cached.unitPrice,
        unit: cached.unit,
        packageQuantity: cached.packageQuantity,
        resolveTerm: null,
      };
    }

    // 2. Not cached → the caller resolves from Home Depot AFTER the row exists, so the
    //    backfill can target it by id. Returning the term rather than enqueueing here is what
    //    makes that possible; enqueueing inline had no id to aim at and matched on text.
    // 3. Meanwhile show the company's own price if the book has it, so a line the book covers
    //    is never blank while the resolve runs.
    const own = find(manualItems);
    if (own) {
      return {
        pricebookCode: own.code,
        unitPrice: own.unitPrice,
        unit: own.unit,
        packageQuantity: own.packageQuantity,
        resolveTerm: term,
      };
    }

    // 4. Nothing anywhere — stay unpriced (the `unmatched` flag) rather than guess.
    return { ...blank, resolveTerm: term };
  };

  /** Start a Home Depot resolve for a row that now has an id the backfill can target. */
  const resolveFor = (
    priced: { resolveTerm: string | null },
    row: { id: string; description: string }
  ) => {
    if (priced.resolveTerm) {
      enqueueResolve(priced.resolveTerm, opts.companyId, row.description, [row.id]);
    }
  };

  for (const op of output.operations) {
    try {
      switch (op.type) {
        case "add_item": {
          if (!op.description) break;
          const priced = priceFields(op.description, null, op.searchTerm);
          const addUnit = op.unit ?? priced.unit;
          // Suppliers sell many small parts only in multiples, so a count is rounded up to a
          // whole pack: four connectors from a 5-pack means buying five. See packMath.
          const addQty = packAwareQuantity(op.quantity, addUnit, priced.packageQuantity);
          if (addQty.rounded)
            logger.info("Rounded quantity up to a whole pack", {
              description: op.description,
              from: op.quantity,
              to: addQty.quantity,
              packageQuantity: priced.packageQuantity,
            });
          const created = await prisma.quoteLineItem.create({
            data: {
              quoteId: opts.quoteId,
              description: op.description,
              quantity: addQty.quantity,
              unit: addUnit,
              unitPrice: priced.unitPrice,
              pricebookCode: priced.pricebookCode,
              sortOrder: nextSort++,
            },
          });
          resolveFor(priced, created);
          break;
        }
        case "kb_proposal": {
          const kb = kbEntries.find((k) => k.id === op.kbEntryId);
          if (!kb) break;
          const description = op.description ?? kb.materialDescription;
          const priced = priceFields(description, kb.pricebookCode, op.searchTerm);
          const kbUnit = op.unit ?? kb.unit ?? priced.unit;
          const kbRawQty =
            op.quantity ?? (kb.defaultQuantity == null ? null : Number(kb.defaultQuantity));
          const kbQty = packAwareQuantity(kbRawQty, kbUnit, priced.packageQuantity);
          const createdKb = await prisma.quoteLineItem.create({
            data: {
              quoteId: opts.quoteId,
              description,
              quantity: kbQty.quantity,
              unit: kbUnit,
              unitPrice: priced.unitPrice,
              pricebookCode: priced.pricebookCode,
              agentSuggested: true,
              sortOrder: nextSort++,
            },
          });
          resolveFor(priced, createdKb);
          break;
        }
        case "update_item": {
          if (!op.itemId || !validIds.has(op.itemId)) break;
          const existing = items.find((i) => i.id === op.itemId)!;
          const data: Record<string, unknown> = {};
          if (op.quantity != null) data.quantity = op.quantity;
          if (op.unit != null) data.unit = op.unit;
          let repriced: ReturnType<typeof priceFields> | null = null;
          if (op.description != null && op.description !== existing.description) {
            data.description = op.description;
            if (!existing.manuallyEdited) {
              const priced = priceFields(op.description, null, op.searchTerm);
              repriced = priced;
              // Only overwrite an existing price when a replacement was actually found.
              // Clearing it unconditionally meant that editing a line's wording during an
              // upstream outage silently unpriced it, with nothing scheduled to restore it.
              if (priced.unitPrice != null) {
                data.pricebookCode = priced.pricebookCode;
                data.unitPrice = priced.unitPrice;
                if (priced.unit && op.unit == null) data.unit = priced.unit;
              }
            }
          }
          // Re-pricing onto a pack row rounds the line's count up too, whether the quantity
          // came from this op or was already on the row.
          if (repriced?.packageQuantity) {
            const effUnit = (data.unit as string | null | undefined) ?? existing.unit;
            const effQty =
              data.quantity != null
                ? Number(data.quantity)
                : existing.quantity == null
                ? null
                : Number(existing.quantity);
            const packed = packAwareQuantity(effQty, effUnit, repriced.packageQuantity);
            if (packed.rounded) data.quantity = packed.quantity;
          }
          if (Object.keys(data).length > 0)
            await prisma.quoteLineItem.update({
              where: { id: op.itemId },
              data,
            });
          if (repriced)
            resolveFor(repriced, {
              id: op.itemId,
              description: op.description ?? existing.description,
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
