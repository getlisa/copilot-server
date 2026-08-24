import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { callStructured, EstimateTurn } from "../estimate/estimateService";
import { ESTIMATED_PRICE_CODE } from "./quoteDto";
import { packAwareQuantity, unitsCompatible } from "./packMath";
import { enqueueResolve } from "./homeDepotCatalog";
import { loadCompanyPricing } from "./companyPricing";
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
 *    → propose an itemized list → add on confirmation
 */

interface AgentOp {
  type:
    | "add_item"
    | "add_labor"
    | "update_item"
    | "remove_item"
    | "ambiguous_reference"
    | "kb_proposal";
  itemId: string | null;
  description: string | null;
  /**
   * add_labor only: the configured labor type this line belongs to, exactly as named in
   * CONFIGURED LABOR TYPES. Null = ad-hoc labor priced at a technician-stated rate
   * (zero types configured, or the named type matched nothing).
   */
  laborTypeName: string | null;
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
  /**
   * Alternative-option group this line belongs to ("Option A – Trench Only"). Null = base
   * scope. Options are mutually exclusive alternatives the customer picks between; totals
   * are computed per group and never summed across groups.
   */
  optionGroup: string | null;
  quantity: number | null;
  unit: string | null;
  /**
   * Technician-STATED price only — labor rates and other prices the catalog cannot know.
   * Never model-invented and never used for materials, which are priced downstream.
   *
   * Always a BASE price, even when the quote carries a markup: a technician stating a rate in
   * conversation is telling us their cost, not a marked-up customer price.
   */
  unitPrice: number | null;
  /**
   * This line is labor/diagnostic time, not a purchasable material. The quote's markup applies
   * to materials only, so this is what keeps labor out of it. Pairs with a null searchTerm.
   */
  isLabor: boolean | null;
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
  /**
   * A materials markup percentage the technician stated this turn, else null. Carried beside
   * the operations rather than as another op type because the op schema is strict with every
   * property required — a new op would force a new required field onto every other op.
   */
  markupPercent: number | null;
  /**
   * Customer details the technician stated this turn, else null. Quote-level fields like
   * markupPercent, carried beside the operations for the same strict-schema reason. Null means
   * "not mentioned" — a null never clears a stored value.
   */
  customerName: string | null;
  customerAddress: string | null;
  customerPhone: string | null;
  reply: string;
  isFollowUpQuestion: boolean;
  questions: AgentQuestion[] | null;
  /**
   * True on the turn where the agent makes THE end-of-materials labor-hours ask (labor PRD
   * US2). Persisted onto the quote so the ask fires at most once, ever.
   */
  askedLaborHours: boolean;
}

const nullable = (t: string) => ({ type: [t, "null"] });

/**
 * Appended to the system prompt: how a stated markup percentage becomes markupPercent.
 * Kept as its own block because it is about a quote-level field, not a line-item operation.
 */
/**
 * Appended to the system prompt: how stated customer details become the customer* fields.
 * Correction ("actually the address is …") needs no machinery of its own — the corrected value
 * is simply the one stated this turn, and it replaces the stored one.
 */
const CUSTOMER_PROMPT = `
CUSTOMER DETAILS. The quote carries the customer's name, address, and phone number — all optional, free text. When the technician states one ("this is for John Miller", "the address is 42 Oak Street", "her number is 555-0142"), set customerName / customerAddress / customerPhone to exactly what they said, each independently — one stated field never requires the others, and never ask for the missing ones. Leave a field null on every turn where it is not stated; null never clears a stored value, and a newly stated value replaces the previous one (corrections work the same way). Never invent, guess, or complete a customer detail — no inferring a name from context, no formatting or "fixing" a phone number or address. These are quote-level fields, never line items, so never emit operations for them. Do not confuse the CUSTOMER's details with product, supplier, or company names.`;

const MARKUP_PROMPT = `
MATERIALS MARKUP. The quote carries one markup percentage that applies to every material line. When the technician states one ("mark it up 20 percent", "add a 15% markup", "make the markup 10"), set markupPercent to that number — 20 for 20%, not 0.2 — and leave it null on every turn where they do not. Setting it replaces any previous value; it is one number for the whole quote, never per line, so never emit line-item operations to apply a markup yourself. A stated 0 clears it. Never invent or suggest a percentage they did not say, and never treat a negative number as a markup: if they ask for a discount or a negative markup, set markupPercent null and say in your reply that markup cannot go below 0%. A price the technician states for a line is always their own cost or rate, never a marked-up figure, so a markup being set changes nothing about how you record it.`;

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
                "add_labor",
                "update_item",
                "remove_item",
                "ambiguous_reference",
                "kb_proposal",
              ],
            },
            itemId: nullable("string"),
            description: nullable("string"),
            laborTypeName: nullable("string"),
            searchTerm: nullable("string"),
            optionGroup: nullable("string"),
            quantity: nullable("number"),
            unit: nullable("string"),
            unitPrice: nullable("number"),
            isLabor: { type: ["boolean", "null"] },
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
            "laborTypeName",
            "searchTerm",
            "optionGroup",
            "quantity",
            "unit",
            "unitPrice",
            "isLabor",
            "action",
            "candidateItemIds",
            "referenceText",
            "kbEntryId",
          ],
        },
      },
      markupPercent: nullable("number"),
      customerName: nullable("string"),
      customerAddress: nullable("string"),
      customerPhone: nullable("string"),
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
      askedLaborHours: { type: "boolean" },
    },
    required: [
      "operations",
      "markupPercent",
      "customerName",
      "customerAddress",
      "customerPhone",
      "reply",
      "isFollowUpQuestion",
      "questions",
      "askedLaborHours",
    ],
  },
};

const SYSTEM_PROMPT = `You are Clara, an expert estimating assistant for field-service technicians working in HVAC, plumbing, fire inspection, fire protection, electrical, and similar technical trades. You help build a quote by talking through a job: parse each utterance into explicit line-item operations against the CURRENT LINE ITEMS you are given. You never price materials — material pricing happens downstream against the org's pricebook. The only price you ever emit is one the technician stated themselves (their labor rate or a hand-quoted amount), via the op's unitPrice field.

Trade expertise: you know the codes and standards that govern this work — NFPA for fire protection (e.g. NFPA 13 sprinkler installation, NFPA 101 life safety), NEC for electrical, ICC codes for building/plumbing, ASHRAE for HVAC. When scoping a described job, briefly share the considerations and standards that matter (design requirements, permits, licensed-contractor requirements, inspections) — but always steer back to building the estimate: that expert context accompanies your clarifying questions and item proposals, it never replaces them. If a query is entirely outside these trades, politely say you're specialized for technical field-service trades.

Rules:
- Multiple items in one statement → one add_item per item.
- ONE PURCHASABLE PRODUCT PER LINE: never bundle products into one item ("EMT fittings", "boxes and covers", "misc hardware"). Split into the actual parts — e.g. "EMT fittings" for a 1/2 in run → separate lines for "1/2 in EMT set screw connector", "1/2 in EMT coupling", "1/2 in EMT strap".
- description is a short product name with its size/spec ("1/2 in EMT conduit", "14 AWG THHN stranded wire"), NOT a sentence of scope ("EMT conduit for new lighting control run"). Put the scope/purpose in your reply, not on the line.
- If the technician corrects/reverses themself within the statement ("actually scratch that, I don't need the panel, I need two panels"), emit only the corrected final intent.
- Changing quantity/size/type of something already in the quote → update_item on that row (never add a duplicate).
- Removing something → remove_item with its itemId.
- If a spoken reference ("that one", "the panel") could match MORE THAN ONE existing line item, NEVER guess: emit ambiguous_reference with action ("remove" or "update"), candidateItemIds, referenceText, and any pending change fields (description/quantity/unit). Do not also emit the underlying op.
- Never invent a quantity — and never add a line without one either: an estimate line with no quantity cannot be priced. If the technician named an item without a count, do NOT emit its add_item yet; ask for the quantity in the questions array (isFollowUpQuestion true, options = 2-5 likely counts/amounts, the UI adds an "Other" free-text box). Add the items whose quantities you do know in the same turn. Never resolve a missing quantity by assumption.
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
  - If a line is genuinely pure labor, diagnosis, or testing with no material to buy, set searchTerm null — it is not a purchasable part and must not be priced as one. Set isLabor true on exactly those lines, and on nothing else: the quote's markup percentage is applied to materials only, so a labor line marked isLabor false gets marked up as if it were a part. Every line naming something purchasable is isLabor false.
  - Same for workmanship/consumables allowances that name no product: "Terminations and feeder makeup" → searchTerm null. No supplier lists "makeup"; price it as a technician-stated allowance or fold it into labor instead.
  - Pure-labor/diagnostic lines are handled by the LABOR CHARGES rules below, never as materials. unitPrice stays null on every material line — materials are priced downstream.
- LABOR CHARGES: labor is captured with the add_labor op — quantity = hours, laborTypeName = the configured type it belongs to, unitPrice = an hourly rate ONLY when the technician stated one themselves. The context lists this client's CONFIGURED LABOR TYPES and whether THE LABOR ASK was already made.
  - Capture immediately when the technician states labor hours unprompted, at any point. The hours must be an EXPLICIT number — never infer one from a vague statement ("probably a couple hours" is not capturable; ask for the number).
  - THE LABOR ASK: when the technician has finished describing the job's materials and has not mentioned labor, ask about labor hours — set askedLaborHours true on that turn. The context tells you if the ask was already made: NEVER repeat it. If they decline or ignore it, move on; labor is fully optional, a quote with no labor is fine, and nothing ever blocks on it.
  - Exactly ONE configured type: ask only for hours — never which type. Emit add_labor with that type's name; leave unitPrice null (the server prices it). If that type's rate is unusable, the server can't price it — the context marks such a type "(no valid rate)": then ask the technician for an hourly rate and put it in unitPrice.
  - MULTIPLE configured types: recite the configured type names and ask which apply — the technician may name MORE THAN ONE, each with its own hours. Emit one add_labor per named type. This is a closed set: match their answer to the configured names only, no fuzzy guessing.
  - Named type matches NO configured name: say that labor type doesn't exist for their company and ask for an hourly rate to use for the job; emit add_labor with laborTypeName null and unitPrice = their stated rate.
  - ZERO configured types: still make the labor ask, and ask for BOTH the hours and the hourly rate in the same exchange. Emit add_labor (laborTypeName null, unitPrice = their rate) only once you have both.
  - BOTH PIECES FIRST: never emit add_labor without hours, and never without either a configured type or a technician-stated rate. Hours alone or a type alone is not yet a line item — ask for what's missing.
  - Corrections vs additions on an existing labor line: "actually make it 3 hours" REPLACES (update_item with quantity 3); "add 2 more hours" ADDS ON TOP (update_item with the summed total). Same distinction as material quantities.
  - Labor lines never carry a searchTerm, and hours must be greater than zero.
  - SCALE the hour options you offer to the scope instead of defaulting small — a small repair is 2-8 hr, a panel/service change 16-32 hr, an industrial motor/feeder job 80-200 hr, a whole-house rewire 60-120 hr — and put a realistic mid value among the options, not as "Other".
  - A technician explicitly declining labor ("no labor line", "materials only", "labor is separate") is their call: honor it, don't re-ask, and don't sneak labor back in on a later turn.
- Units: keep what the technician said (ft, EA, etc.), else null.
- ALTERNATIVE OPTIONS: when the technician quotes a job as alternatives the customer picks between ("price it both ways", "Option A conduit only / Option B full feed", "give them three options"), set optionGroup on EVERY line that belongs to an option — a short customer-facing name like "Option A – Trench and Raceway Only" — and keep it null on base-scope lines common to all choices. Lines in different option groups are mutually exclusive: they are totaled per group and NEVER added together, so a line that belongs in both options must be added to each group separately. Never fold alternative scopes into ungrouped lines — that silently bills the customer for both.
- Wire, cable, and conduit quantities are LENGTHS in feet — runs × run length — never a count of conductors or runs. "4 conductors over an 85 ft run" → quantity 340, unit ft. A count can't be priced against per-foot goods and leaves the line unpriced.
- The technician may attach photos. Use them to identify equipment, materials, model/size details, and site conditions when parsing items or scoping a job — but still never invent quantities or prices from a photo alone.

Whenever you ask ANY clarifying question (isFollowUpQuestion true), put the question(s) ONLY in the questions array as multiple-choice: 2-5 short, likely answer options each. The UI renders that array as tappable options right below your reply, so NEVER write the questions themselves (or a list of them) in the reply text — the reply is one or two sentences of lead-in/expert context only, no question list, no "1." / bullets of questions. Set questions to null when you are not asking anything.

Described problems or jobs (no specific material named, e.g. "need to install an EV charger"):
- Check the KNOWLEDGE BASE ENTRIES first. Exactly one entry clearly fits → kb_proposal with its kbEntryId (quantity from the entry unless the technician said one). In your reply, make clear this is a suggestion they must confirm.
- Otherwise, use your own trade knowledge to scope the job. Follow this sequence:
  1. CLARIFY: if details that materially change the equipment list are unknown (e.g. for an EV charger: level/amperage, distance from the panel, indoor or outdoor, panel capacity), ask in ONE round (isFollowUpQuestion true, no operations): populate the questions array with 1-4 short questions, each with 2-5 likely answer options covering the common cases (the UI adds an "Other" free-text box automatically). Keep the reply itself to a brief lead-in with any expert context. Ask as many rounds as the job genuinely needs, but batch related questions into one round and never re-ask something already answered.
  2. PROPOSE: reply with a clearly itemized list of the equipment/materials needed — each with a quantity and unit where sensible — and ask the technician to confirm before you add anything (NO operations yet). If any proposed item still needs an answer from the technician (unknown quantity, size, gauge, count), NEVER write "TBD" or ask for it in the reply text: set isFollowUpQuestion true and put one multiple-choice question per unknown in the questions array (2-5 likely values as options — e.g. cable size → "12/2" / "14/2"; counts → "1" / "2" / "3"; the UI adds an "Other" free-text box for exact amounts). Set isFollowUpQuestion false only when the list has no unknowns left.
  3. CONFIRM & ADD: when the technician confirms (or confirms with changes), emit one add_item per agreed item with its quantity and unit. If they adjust the list, apply their adjustments. If any agreed item STILL lacks a quantity, add the ones that have quantities and ask for the missing ones via the questions array — never emit an add_item with quantity null.
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

interface LaborRateLite {
  id: number;
  name: string;
  hourlyRate: number;
}

function buildTurnContext(
  items: QuoteLineItem[],
  kbEntries: KbEntryLite[],
  utterance: string,
  /** Pricebook rows keyed by code, so priced lines can expose product link/brand/rating. */
  catalog?: Map<string, PricebookItem>,
  laborRates: LaborRateLite[] = [],
  laborAsked = false
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
              `${i.isLabor ? ` | LABOR line${i.unitPrice != null ? ` @ $${Number(i.unitPrice)}/hr` : ""}` : ""}` +
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
  const laborLines =
    laborRates.length === 0
      ? "(none configured — ask for BOTH hours and an hourly rate when capturing labor)"
      : laborRates
          .map((r) => `- ${r.name} — $${r.hourlyRate}/hr`)
          .join("\n");
  return `CURRENT LINE ITEMS:
${itemLines}

KNOWLEDGE BASE ENTRIES (problem → material):
${kbLines}

CONFIGURED LABOR TYPES for this client:
${laborLines}

THE LABOR ASK was already made for this quote: ${laborAsked ? "YES — never ask again" : "no"}.

TECHNICIAN SAID:
${utterance}`;
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
  /** Presigned URLs of photos attached to this turn (vision input). */
  imageUrls?: string[];
}): Promise<AgentTurnResult> {
  const [items, kbEntries, pricing, laborRates, quoteRow] = await Promise.all([
    prisma.quoteLineItem.findMany({
      where: { quoteId: opts.quoteId },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.kbEntry.findMany({ where: { companyId: opts.companyId } }),
    loadCompanyPricing(opts.companyId),
    prisma.laborRate.findMany({ where: { companyId: opts.companyId } }),
    prisma.quote.findUnique({ where: { id: opts.quoteId }, select: { laborAsked: true } }),
  ]);
  const laborRatesLite: LaborRateLite[] = laborRates.map((r) => ({
    id: r.id,
    name: r.name,
    hourlyRate: Number(r.hourlyRate),
  }));

  // Self-heal: lines whose pricing failed on an earlier turn retry here — one search per
  // item, individually, capped at MAX_RESOLVE_ATTEMPTS total tries per term by the attempt
  // ledger in enqueueResolve, so a genuinely unstocked item stops consuming searches after
  // its retries are spent. Manually priced lines and pending ambiguous references are not
  // pricing failures, so they are skipped. Fire-and-forget: the turn never waits on it.
  // The stored searchTerm is the catalog-shaped part name and is what pricing matches on;
  // description is customer prose and only stands in for lines created before the column
  // existed. The resolver also canonicalizes a failed term once before giving up.
  // Home Depot fallback is per-client and off by default (pricebook-config PRD US5): with
  // it off, an unpriced line simply stays unmatched — no live lookup ever runs.
  if (pricing.fallbackEnabled) {
    for (const line of items) {
      // An estimated price counts as unpriced for this purpose: it came from a web search, not
      // the catalog, so it must keep trying for a real product price rather than settling.
      if (
        (line.unitPrice == null || line.pricebookCode === ESTIMATED_PRICE_CODE) &&
        !line.manuallyEdited &&
        !line.isLabor && // labor is never priced from a catalog
        !line.ambiguousAction
      ) {
        enqueueResolve(line.searchTerm ?? line.description, opts.companyId, line.description, [line.id]);
      }
    }
  }

  const catalog = new Map(pricing.rawRows.map((p) => [p.code, p]));
  const turnContext = buildTurnContext(
    items,
    kbEntries,
    opts.utterance,
    catalog,
    laborRatesLite,
    quoteRow?.laborAsked === true
  );
  const { raw } = await callStructured({
    system: SYSTEM_PROMPT + MARKUP_PROMPT + CUSTOMER_PROMPT,
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

  const validIds = new Set(items.map((i) => i.id));
  let nextSort =
    items.length > 0 ? Math.max(...items.map((i) => i.sortOrder)) + 1 : 0;

  /**
   * `searchTerm` is the catalog-shaped part name and is tried FIRST; `description` is prose
   * written for the customer and matches poorly (measured: 11 of 13 lines across three real
   * quotes were unmatchable scope text). A null searchTerm on a labor/diagnostic line is a
   * deliberate signal that there is nothing to buy — no lookup, no price.
   *
   * Order (pricebook-config PRD): the client's own books (priority order, higher price wins
   * a collision) → Home Depot cache/live ONLY when the client's fallback toggle is on. A
   * book hit is final: Home Depot never overrides the client's own price.
   */
  const priceFields = (
    description: string,
    explicitCode?: string | null,
    searchTerm?: string | null
  ) => {
    const term = searchTerm?.trim() || null;
    const blank = {
      pricebookCode: null as string | null,
      unitPrice: null as number | null,
      unit: null as string | null,
      packageQuantity: null as number | null,
      sourcePricebookId: null as number | null,
      resolveTerm: null as string | null,
    };

    // 0. An explicit KB code is a curated, exact identity mapping. It outranks any fuzzy
    //    match, and its line must not be re-resolved — the backfill would otherwise overwrite
    //    a human-chosen code with whatever the catalog returned for a generated searchTerm.
    const curated = explicitCode ? pricing.byCode.get(explicitCode) : undefined;
    if (curated) {
      return {
        pricebookCode: curated.code,
        unitPrice: curated.unitPrice,
        unit: curated.unit,
        packageQuantity: curated.packageQuantity,
        sourcePricebookId: curated.sourcePricebookId,
        resolveTerm: null,
      };
    }

    // A null searchTerm means "not a purchasable part" (labour, diagnosis, testing). Honour it
    // literally: no lookup at all. Falling back to the prose description here priced labour
    // lines as parts — "Install 20A breaker" matched a $7.26 breaker and even attached its
    // product link, asserting that the labour line WAS that breaker.
    if (!term) return blank;

    // 1. Client books first (collision rule inside), then the HD cache when fallback is on.
    const hit = pricing.match(term);
    if (hit) {
      return {
        pricebookCode: hit.code,
        unitPrice: hit.unitPrice,
        unit: hit.unit,
        packageQuantity: hit.packageQuantity,
        sourcePricebookId: hit.sourcePricebookId,
        resolveTerm: null,
      };
    }

    // 2. Nothing anywhere. With fallback on, the caller starts a live Home Depot resolve
    //    AFTER the row exists so the backfill can target it by id; with fallback off the
    //    line simply stays unpriced (the `unmatched` flag) — no lookup of any kind.
    return { ...blank, resolveTerm: pricing.fallbackEnabled ? term : null };
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
          // Technician-stated price (labor rate, hand-quoted amount): used as-is, flagged
          // like a manual edit so no catalog resolve or backfill ever overwrites it.
          if (op.unitPrice != null) {
            await prisma.quoteLineItem.create({
              data: {
                quoteId: opts.quoteId,
                description: op.description,
                quantity: op.quantity,
                unit: op.unit,
                unitPrice: op.unitPrice,
                optionGroup: op.optionGroup?.trim() || null,
                isLabor: op.isLabor === true,
                manuallyEdited: true,
                sortOrder: nextSort++,
              },
            });
            break;
          }
          let priced = priceFields(op.description, null, op.searchTerm);
          const addUnit = op.unit ?? priced.unit;
          // A price only applies to a line whose unit measures the same thing: 2,000 ft ×
          // an each-price is a $288k quote. Incompatible → stay unpriced/flagged instead.
          if (priced.unitPrice != null && !unitsCompatible(addUnit, priced.unit)) {
            logger.info("Price refused: line unit incompatible with priced unit", {
              description: op.description,
              lineUnit: addUnit,
              pricedUnit: priced.unit,
            });
            priced = {
              pricebookCode: null,
              unitPrice: null,
              unit: null,
              packageQuantity: null,
              sourcePricebookId: null,
              resolveTerm: priced.resolveTerm,
            };
          }
          // Suppliers sell many small parts only in multiples, so a count is rounded up to a
          // whole pack: four connectors from a 5-pack means buying five. See packMath.
          const addQty = packAwareQuantity(op.quantity, addUnit, priced.packageQuantity, priced.unit);
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
              searchTerm: op.searchTerm?.trim() || null,
              quantity: addQty.quantity,
              unit: addUnit,
              unitPrice: priced.unitPrice,
              pricebookCode: priced.pricebookCode,
              sourcePricebookId: priced.sourcePricebookId,
              optionGroup: op.optionGroup?.trim() || null,
              isLabor: op.isLabor === true,
              sortOrder: nextSort++,
            },
          });
          resolveFor(priced, created);
          break;
        }
        case "add_labor": {
          // Both pieces must be known before a labor line exists (labor PRD US4/US5):
          // hours > 0, and either a configured type or a technician-stated rate.
          const hours = op.quantity;
          if (hours == null || !(hours > 0)) break;
          const typeName = op.laborTypeName?.trim() || null;
          const configured = typeName
            ? laborRatesLite.find((r) => r.name.toLowerCase() === typeName.toLowerCase())
            : laborRatesLite.length === 1 && op.unitPrice == null
            ? laborRatesLite[0]
            : null;
          const rate = configured ? configured.hourlyRate : op.unitPrice;
          if (rate == null || rate < 0) break; // no configured type and no stated rate → not yet a line
          const laborLine = await prisma.quoteLineItem.create({
            data: {
              quoteId: opts.quoteId,
              description: op.description ?? configured?.name ?? "Labor",
              quantity: hours,
              unit: "hr",
              unitPrice: rate,
              isLabor: true,
              laborRateId: configured?.id ?? null,
              // An ad-hoc technician-stated rate is an ordinary priced line (US5), not a
              // manual override of configured data — manuallyEdited stays false either way.
              optionGroup: op.optionGroup?.trim() || null,
              sortOrder: nextSort++,
            },
          });
          // Audit trail (labor PRD): every labor line creation is logged with its values.
          logger.info("Labor line created", {
            quoteId: opts.quoteId,
            lineItemId: laborLine.id,
            laborType: configured?.name ?? "(ad-hoc rate)",
            hours,
            hourlyRate: rate,
          });
          break;
        }
        case "kb_proposal": {
          const kb = kbEntries.find((k) => k.id === op.kbEntryId);
          if (!kb) break;
          const description = op.description ?? kb.materialDescription;
          let priced = priceFields(description, kb.pricebookCode, op.searchTerm);
          const kbUnit = op.unit ?? kb.unit ?? priced.unit;
          if (priced.unitPrice != null && !unitsCompatible(kbUnit, priced.unit)) {
            logger.info("Price refused: line unit incompatible with priced unit", {
              description,
              lineUnit: kbUnit,
              pricedUnit: priced.unit,
            });
            priced = {
              pricebookCode: null,
              unitPrice: null,
              unit: null,
              packageQuantity: null,
              sourcePricebookId: null,
              resolveTerm: priced.resolveTerm,
            };
          }
          const kbRawQty =
            op.quantity ?? (kb.defaultQuantity == null ? null : Number(kb.defaultQuantity));
          const kbQty = packAwareQuantity(kbRawQty, kbUnit, priced.packageQuantity, priced.unit);
          const createdKb = await prisma.quoteLineItem.create({
            data: {
              quoteId: opts.quoteId,
              description,
              searchTerm: op.searchTerm?.trim() || null,
              quantity: kbQty.quantity,
              unit: kbUnit,
              unitPrice: priced.unitPrice,
              pricebookCode: priced.pricebookCode,
              sourcePricebookId: priced.sourcePricebookId,
              optionGroup: op.optionGroup?.trim() || null,
              isLabor: op.isLabor === true,
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
          if (op.quantity != null) {
            // Labor hours must be greater than zero — the labor PRD's one sanity check.
            if (existing.isLabor && !(op.quantity > 0)) break;
            data.quantity = op.quantity;
          }
          if (op.unit != null) data.unit = op.unit;
          if (op.unitPrice != null) {
            data.unitPrice = op.unitPrice;
            // Overriding a labor line's RATE away from its configured value is what the
            // manually-edited flag is for (labor PRD US7); hours edits never set it.
            data.manuallyEdited = true;
            data.sourcePricebookId = null; // technician's own number — no book is the source
          }
          if (op.isLabor != null) data.isLabor = op.isLabor;
          // Audit trail (labor PRD): hours corrections/additions log prior and new values.
          if (existing.isLabor && op.quantity != null)
            logger.info("Labor line hours updated", {
              quoteId: opts.quoteId,
              lineItemId: existing.id,
              priorHours: existing.quantity == null ? null : Number(existing.quantity),
              newHours: op.quantity,
            });
          let repriced: ReturnType<typeof priceFields> | null = null;
          if (op.description != null && op.description !== existing.description) {
            data.description = op.description;
            if (op.searchTerm?.trim()) data.searchTerm = op.searchTerm.trim();
            if (!existing.manuallyEdited) {
              const priced = priceFields(op.description, null, op.searchTerm);
              repriced = priced;
              // Only overwrite an existing price when a replacement was actually found.
              // Clearing it unconditionally meant that editing a line's wording during an
              // upstream outage silently unpriced it, with nothing scheduled to restore it.
              // And a found price must measure what the line measures (see unitsCompatible)
              // — a per-EA spool price never applies to a line stated in feet.
              if (
                priced.unitPrice != null &&
                unitsCompatible(op.unit ?? existing.unit ?? priced.unit, priced.unit)
              ) {
                data.pricebookCode = priced.pricebookCode;
                data.unitPrice = priced.unitPrice;
                data.sourcePricebookId = priced.sourcePricebookId;
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
            const packed = packAwareQuantity(effQty, effUnit, repriced.packageQuantity, repriced.unit);
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

  // A markup stated in the chat and one typed on the Invoice tab are the same single value on
  // the quote, so this writes the same column the PATCH endpoint does. Negatives are refused
  // rather than clamped to 0: silently turning "mark it down 10%" into "no markup" would look
  // like the request was honoured.
  const stated = output.markupPercent;
  if (typeof stated === "number" && Number.isFinite(stated) && stated >= 0 && stated <= 999.99) {
    await prisma.quote.update({
      where: { id: opts.quoteId },
      data: { markupPercent: stated },
    });
  }

  // Customer details stated in chat write the same columns the Invoice tab's fields PATCH, so
  // the two entry paths are one underlying value. Null = not mentioned this turn — a stored
  // value is only ever replaced, never cleared, by the agent.
  const customerData: Record<string, string> = {};
  for (const field of ["customerName", "customerAddress", "customerPhone"] as const) {
    const value = output[field];
    if (typeof value === "string" && value.trim()) {
      customerData[field] = value.trim().slice(0, 500);
    }
  }
  if (Object.keys(customerData).length > 0) {
    await prisma.quote.update({ where: { id: opts.quoteId }, data: customerData });
  }

  // The end-of-materials labor ask fires at most once per quote (labor PRD US2): record
  // that it happened so every later turn's context says "never ask again".
  if (output.askedLaborHours === true && quoteRow?.laborAsked !== true) {
    await prisma.quote.update({
      where: { id: opts.quoteId },
      data: { laborAsked: true },
    });
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
