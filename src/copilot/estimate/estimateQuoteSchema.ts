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
          },
          required: ["sourceSheet", "code", "description", "kind", "quantity", "unit", "unitPrice", "lineTotal"],
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
