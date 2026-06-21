import { z } from "zod";

/**
 * Structured cost-estimate ("quote") schema.
 *
 * DEMO-ONLY. This is the shape the estimate endpoint emits in its `quote` SSE
 * frame and persists on the AI message metadata. It is intentionally decoupled
 * from the live copilot — nothing here is shared with the production prompt or
 * the LangGraph workflow.
 *
 * `status` gates whether a quote card should be shown at all:
 *   - "needs_info": the copilot is asking clarifying questions / lacks the detail
 *     to price the job. NO quote card is rendered for this turn.
 *   - "estimate": a complete, itemized estimate with a numeric total.
 *
 * The card is a flat summary (materials + labor flattened into `lineItems`); the
 * full reasoning, ranges, and NFPA notes live in the streamed markdown.
 */

export const lineItemTypeEnum = z.enum([
  "equipment", // a whole replacement unit (e.g. a new sprinkler head)
  "part", // a component used in a repair (e.g. seal, fusible link)
  "labor", // technician time
  "access", // lift / scaffold / access equipment
  "other", // permits, disposal, drain-down, fire watch, misc.
]);

export const lineItemSchema = z.object({
  label: z.string().describe("Human-readable description of this line item."),
  type: lineItemTypeEnum,
  quantity: z.number().describe("Quantity, or typical hours (midpoint) for labor."),
  unitCost: z.number().describe("Cost per unit, or hourly rate for labor."),
  amount: z.number().describe("quantity * unitCost."),
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
    .describe("'estimate' only if a complete itemized quote with a total exists; else 'needs_info'."),
  identifiedEquipment: identifiedEquipmentSchema,
  lineItems: z.array(lineItemSchema).describe("Flattened materials + labor line items."),
  laborHours: z.number().describe("Total typical labor hours (midpoint). 0 if needs_info."),
  laborRate: z.number().describe("Primary labor rate per hour. 0 if needs_info."),
  subtotal: z.number().describe("Sum of all line item amounts. 0 if needs_info."),
  total: z.number().describe("Final estimated total (single number). 0 if needs_info."),
  currency: z.string().describe("ISO currency code, e.g. 'USD'."),
  assumptions: z
    .array(z.string())
    .describe("Assumptions the estimate depends on, or the open questions if needs_info."),
  notes: z.string().describe("Short closing note / customer flags."),
});

export type EstimateQuote = z.infer<typeof estimateQuoteSchema>;

/**
 * JSON Schema for the OpenAI `response_format: { type: "json_schema" }` structured
 * output. Hand-authored (rather than zod-to-json-schema) to keep the dependency
 * surface identical to a clean `main` — and because OpenAI strict mode requires
 * `additionalProperties: false` and every property listed in `required`.
 */
export const estimateQuoteJsonSchema = {
  name: "cost_estimate",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["estimate", "needs_info"] },
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
            label: { type: "string" },
            type: {
              type: "string",
              enum: ["equipment", "part", "labor", "access", "other"],
            },
            quantity: { type: "number" },
            unitCost: { type: "number" },
            amount: { type: "number" },
          },
          required: ["label", "type", "quantity", "unitCost", "amount"],
        },
      },
      laborHours: { type: "number" },
      laborRate: { type: "number" },
      subtotal: { type: "number" },
      total: { type: "number" },
      currency: { type: "string" },
      assumptions: { type: "array", items: { type: "string" } },
      notes: { type: "string" },
    },
    required: [
      "status",
      "identifiedEquipment",
      "lineItems",
      "laborHours",
      "laborRate",
      "subtotal",
      "total",
      "currency",
      "assumptions",
      "notes",
    ],
  },
} as const;
