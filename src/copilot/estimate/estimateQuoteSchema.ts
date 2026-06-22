import { z } from "zod";

/**
 * Structured cost-estimate ("quote") schema — follows the pricebook's quotation
 * format (docs/EQUIPMENT_DATA.md §6): each line carries its source sheet + code,
 * and totals split into Materials+Services / Labor / Tax.
 *
 * DEMO/feature note: emitted in the `quote` SSE frame and persisted on the AI
 * message metadata. Decoupled from the live copilot.
 *
 * `status` gates whether a card is shown:
 *   - "needs_info": copilot is asking clarifying questions → NO card this turn.
 *   - "estimate": a complete itemized quotation with a numeric total.
 */

export const lineItemKindEnum = z.enum([
  "material", // a part from a materials sheet (SP-/FA-/EX-/KH-/VL-/FD-/HG-/HS-/BF-/SH-…)
  "service", // a flat-fee standard service (SV-…)
  "labor", // a labor-benchmark task (LH-/LA-/LV-/LK-/LI-/LS-/LT-/LQ-/LBF-/LP-…)
  "rental", // equipment/access rental (LB-030…036)
  "permit", // permits / AHJ fees (LB-040…045)
  "other", // anything else (mark as assumption)
]);

export const lineItemSchema = z.object({
  sourceSheet: z
    .string()
    .describe("Pricebook sheet, e.g. 'Sprinkler Materials', 'Labor Benchmarks', 'Standard Services'."),
  code: z.string().describe("Pricebook code, e.g. 'SP-010', 'LH-002', 'SV-002', 'LB-030'."),
  description: z.string().describe("Human-readable line description."),
  kind: lineItemKindEnum,
  quantity: z.number().describe("Quantity, or hours (Mid Hrs) for labor lines."),
  unit: z.string().describe("Unit of measure: EA, HR, RL, DAY, CALL, TRIP, MILE, etc."),
  unitPrice: z.number().describe("Unit price / hourly rate from the pricebook."),
  lineTotal: z.number().describe("quantity * unitPrice."),
  isIdentifiedEquipment: z
    .boolean()
    .describe("True on the ONE line that is the photographed/identified equipment (for the PDF thumbnail)."),
});

export const identifiedEquipmentSchema = z.object({
  brand: z.string().describe("Best-guess brand, e.g. 'Tyco'. Proactively chosen."),
  model: z.string().describe("Best-guess model/part number (with 'or equiv.')."),
  category: z.string().describe("Equipment category, e.g. 'Pendant sprinkler head'."),
  issue: z.string().describe("The fault identified from the photo/description."),
  decision: z
    .enum(["repair", "replace"])
    .describe("Whether the item should be repaired or fully replaced."),
  confidence: z.number().min(0).max(1).describe("Identification confidence (0-1)."),
});

export const estimateQuoteSchema = z.object({
  status: z
    .enum(["estimate", "needs_info"])
    .describe("'estimate' only if a complete itemized quotation with a total exists; else 'needs_info'."),
  title: z.string().describe("Short job title, e.g. 'Loading Dock — Painted Head Replacement'."),
  identifiedEquipment: identifiedEquipmentSchema,
  lineItems: z.array(lineItemSchema).describe("Quotation line items (materials, services, labor, rentals, permits)."),
  materialsServicesSubtotal: z.number().describe("Sum of all non-labor line totals. 0 if needs_info."),
  laborSubtotal: z.number().describe("Sum of labor line totals. 0 if needs_info."),
  taxOther: z.number().describe("Tax / other charges. 0 if none."),
  total: z.number().describe("TOTAL QUOTE = materials+services + labor + tax. 0 if needs_info."),
  currency: z.string().describe("ISO currency code, e.g. 'USD'."),
  assumptions: z
    .array(z.string())
    .describe("Assumptions the estimate depends on, or the open questions if needs_info."),
  customerNotes: z
    .array(z.string())
    .describe("Compliance flags / advisories for the customer (NFPA references). No pricing disclaimers."),
});

export type EstimateQuote = z.infer<typeof estimateQuoteSchema>;

/**
 * A follow-up question the copilot asks when the request is too vague to price.
 * The UI renders `options` as buttons; `allowOther` (always true) adds an "Other"
 * entry for typed/spoken free text.
 */
export const followUpQuestionSchema = z.object({
  id: z.string().describe("Stable id for this question, e.g. 'ceiling_type'."),
  question: z.string().describe("The question text shown to the technician."),
  options: z
    .array(
      z.object({
        id: z.string().describe("Stable option id."),
        label: z.string().describe("Button label, e.g. 'Drop tile ceiling'."),
        value: z.string().describe("Answer text sent back as `content` when picked."),
      })
    )
    .describe("2-4 suggested single-select answers."),
  allowOther: z.boolean().describe("Always true — UI shows an 'Other' free-text/voice entry."),
});

export type FollowUpQuestion = z.infer<typeof followUpQuestionSchema>;

/**
 * `identify` node output: what the equipment is and whether we can price it yet.
 * When canPrice is false, `questions` holds the required follow-ups.
 */
export const identifyResultSchema = z.object({
  identification: identifiedEquipmentSchema,
  canPrice: z.boolean().describe("True when there's enough to build a real quote."),
  questions: z
    .array(followUpQuestionSchema)
    .describe("Required follow-ups when canPrice is false; [] otherwise."),
  message: z.string().describe("Concise chat-bubble lead-in. No itemized table."),
});

export type IdentifyResult = z.infer<typeof identifyResultSchema>;

/** `build_quote` node output: the priced quotation + a concise chat-bubble message. */
export const quoteResultSchema = z.object({
  quote: estimateQuoteSchema,
  message: z.string().describe("Concise chat-bubble lead-in incl. the headline total."),
});

export type QuoteResult = z.infer<typeof quoteResultSchema>;

/**
 * JSON Schema for the OpenAI `response_format: { type: "json_schema" }` structured
 * output. Hand-authored; strict mode requires `additionalProperties: false` and
 * every property in `required`.
 */
export const estimateQuoteJsonSchema = {
  name: "fire_protection_quote",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["estimate", "needs_info"] },
      title: { type: "string" },
      identifiedEquipment: {
        type: "object",
        additionalProperties: false,
        properties: {
          brand: { type: "string" },
          model: { type: "string" },
          category: { type: "string" },
          issue: { type: "string" },
          decision: { type: "string", enum: ["repair", "replace"] },
          confidence: { type: "number" },
        },
        required: ["brand", "model", "category", "issue", "decision", "confidence"],
      },
      lineItems: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            sourceSheet: { type: "string" },
            code: { type: "string" },
            description: { type: "string" },
            kind: {
              type: "string",
              enum: ["material", "service", "labor", "rental", "permit", "other"],
            },
            quantity: { type: "number" },
            unit: { type: "string" },
            unitPrice: { type: "number" },
            lineTotal: { type: "number" },
            isIdentifiedEquipment: { type: "boolean" },
          },
          required: ["sourceSheet", "code", "description", "kind", "quantity", "unit", "unitPrice", "lineTotal", "isIdentifiedEquipment"],
        },
      },
      materialsServicesSubtotal: { type: "number" },
      laborSubtotal: { type: "number" },
      taxOther: { type: "number" },
      total: { type: "number" },
      currency: { type: "string" },
      assumptions: { type: "array", items: { type: "string" } },
      customerNotes: { type: "array", items: { type: "string" } },
    },
    required: [
      "status",
      "title",
      "identifiedEquipment",
      "lineItems",
      "materialsServicesSubtotal",
      "laborSubtotal",
      "taxOther",
      "total",
      "currency",
      "assumptions",
      "customerNotes",
    ],
  },
} as const;

/** Strict JSON Schema for one follow-up question (reused by the identify result). */
const followUpQuestionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    question: { type: "string" },
    options: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          value: { type: "string" },
        },
        required: ["id", "label", "value"],
      },
    },
    allowOther: { type: "boolean" },
  },
  required: ["id", "question", "options", "allowOther"],
} as const;

/** Strict JSON Schema for the `identify` node output. Reuses the equipment schema. */
export const identifyResultJsonSchema = {
  name: "identify_result",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      identification: estimateQuoteJsonSchema.schema.properties.identifiedEquipment,
      canPrice: { type: "boolean" },
      questions: { type: "array", items: followUpQuestionJsonSchema },
      message: { type: "string" },
    },
    required: ["identification", "canPrice", "questions", "message"],
  },
} as const;

/** Strict JSON Schema for the `build_quote` node output. Reuses the quote schema. */
export const quoteResultJsonSchema = {
  name: "quote_result",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      quote: estimateQuoteJsonSchema.schema,
      message: { type: "string" },
    },
    required: ["quote", "message"],
  },
} as const;
