import { z } from "zod";

/**
 * Structured cost-estimate ("quote") schema.
 *
 * DEMO-ONLY. This is the shape the estimate endpoint emits in its `quote` SSE
 * frame and persists on the AI message metadata. It is intentionally decoupled
 * from the live copilot — nothing here is shared with the production prompt or
 * the LangGraph workflow.
 */

export const lineItemTypeEnum = z.enum([
  "equipment", // a whole replacement unit (e.g. a new sprinkler head)
  "part", // a component used in a repair (e.g. seal, deflector)
  "labor", // technician time
  "access", // lift / scaffold / access equipment
  "other", // permits, disposal, travel, misc.
]);

export const lineItemSchema = z.object({
  label: z.string().describe("Human-readable description of this line item."),
  type: lineItemTypeEnum,
  quantity: z.number().describe("Quantity or hours (for labor)."),
  unitCost: z.number().describe("Cost per unit/hour in the quote currency."),
  amount: z.number().describe("quantity * unitCost."),
});

export const identifiedEquipmentSchema = z.object({
  brand: z.string().describe("Best-guess brand, e.g. 'Tyco'. Proactively chosen."),
  model: z.string().describe("Best-guess model/part number."),
  category: z.string().describe("Equipment category, e.g. 'Fire sprinkler head'."),
  issue: z.string().describe("The fault identified from the photo/description."),
  decision: z
    .enum(["repair", "replace"])
    .describe("Whether the item should be repaired or fully replaced."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Model confidence in the identification (0-1)."),
});

export const estimateQuoteSchema = z.object({
  identifiedEquipment: identifiedEquipmentSchema,
  lineItems: z.array(lineItemSchema).describe("Itemized cost breakdown."),
  laborHours: z.number().describe("Total estimated labor hours."),
  laborRate: z.number().describe("Labor rate per hour in the quote currency."),
  subtotal: z.number().describe("Sum of all line item amounts before tax."),
  total: z.number().describe("Final estimated total."),
  currency: z.string().describe("ISO currency code, e.g. 'USD'."),
  assumptions: z
    .array(z.string())
    .describe("Assumptions the estimate depends on (access, quantities, etc.)."),
  notes: z.string().describe("Short closing note. Include the demo disclaimer."),
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
