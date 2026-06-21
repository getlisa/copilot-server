import { z } from "zod";

/**
 * Structured cost-estimate ("quote") schema.
 *
 * DEMO-ONLY. This is the shape the estimate endpoint emits in its `quote` SSE
 * frame and persists on the AI message metadata. It mirrors the quote structure
 * in docs/Clara_FieldCopilot_Agent_Reference.md: materials and labor are split,
 * labor is always a RANGE (low–high), system-offline and compliance items are
 * captured explicitly, and customer-facing flags live in their own block.
 *
 * It is intentionally decoupled from the live copilot — nothing here is shared
 * with the production prompt or the LangGraph workflow.
 */

export const laborTierEnum = z.enum([
  "Tech I",
  "Tech II",
  "Tech III",
  "Tech IV",
  "Emergency",
]);

/** A material/part line — fixed price. */
export const materialItemSchema = z.object({
  label: z.string().describe("Description, e.g. 'Pendant head 1/2\" NPT 200°F'."),
  partNumber: z.string().describe("Part number or 'equiv.'; '' if unknown."),
  quantity: z.number(),
  unitPrice: z.number(),
  amount: z.number().describe("quantity * unitPrice."),
});

/** A labor line — always a range. */
export const laborItemSchema = z.object({
  task: z.string().describe("Task + condition, e.g. 'Replace head — suspended tile, 10ft'."),
  hoursLow: z.number(),
  hoursHigh: z.number(),
  rate: z.number().describe("Hourly rate for the tier."),
  tier: laborTierEnum,
  amountLow: z.number().describe("hoursLow * rate."),
  amountHigh: z.number().describe("hoursHigh * rate."),
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

export const systemOfflineSchema = z.object({
  required: z.boolean().describe("True if the wet system must be drained for this work."),
  estimatedHours: z.string().describe("Expected offline window, e.g. '3–4 hours'; '' if N/A."),
  note: z.string().describe("Short customer-facing note; '' if N/A."),
});

export const estimateQuoteSchema = z.object({
  title: z.string().describe("Short job title, e.g. 'Loading Dock — Painted Head Replacement'."),
  identifiedEquipment: identifiedEquipmentSchema,
  materials: z.array(materialItemSchema).describe("Material/part line items."),
  labor: z.array(laborItemSchema).describe("Labor line items (each a range)."),
  accessEquipment: z
    .array(z.object({ label: z.string(), cost: z.number() }))
    .describe("Lift/scaffold/equipment rentals; [] if none."),
  systemOffline: systemOfflineSchema,
  materialsSubtotal: z.number(),
  laborSubtotalLow: z.number(),
  laborSubtotalHigh: z.number(),
  totalLow: z.number().describe("Low end of the total estimate."),
  totalHigh: z.number().describe("High end of the total estimate."),
  currency: z.string().describe("ISO currency code, e.g. 'USD'."),
  assumptions: z.array(z.string()).describe("Assumptions the estimate depends on."),
  customerNotes: z
    .array(z.string())
    .describe("Compliance flags / advisories for the customer (NFPA references)."),
});

export type EstimateQuote = z.infer<typeof estimateQuoteSchema>;

/**
 * JSON Schema for the OpenAI `response_format: { type: "json_schema" }` structured
 * output. Hand-authored to keep the dependency surface identical to a clean `main`
 * and because OpenAI strict mode requires `additionalProperties: false` and every
 * property listed in `required`.
 */
export const estimateQuoteJsonSchema = {
  name: "fire_protection_estimate",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
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
      materials: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            partNumber: { type: "string" },
            quantity: { type: "number" },
            unitPrice: { type: "number" },
            amount: { type: "number" },
          },
          required: ["label", "partNumber", "quantity", "unitPrice", "amount"],
        },
      },
      labor: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            task: { type: "string" },
            hoursLow: { type: "number" },
            hoursHigh: { type: "number" },
            rate: { type: "number" },
            tier: {
              type: "string",
              enum: ["Tech I", "Tech II", "Tech III", "Tech IV", "Emergency"],
            },
            amountLow: { type: "number" },
            amountHigh: { type: "number" },
          },
          required: ["task", "hoursLow", "hoursHigh", "rate", "tier", "amountLow", "amountHigh"],
        },
      },
      accessEquipment: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            cost: { type: "number" },
          },
          required: ["label", "cost"],
        },
      },
      systemOffline: {
        type: "object",
        additionalProperties: false,
        properties: {
          required: { type: "boolean" },
          estimatedHours: { type: "string" },
          note: { type: "string" },
        },
        required: ["required", "estimatedHours", "note"],
      },
      materialsSubtotal: { type: "number" },
      laborSubtotalLow: { type: "number" },
      laborSubtotalHigh: { type: "number" },
      totalLow: { type: "number" },
      totalHigh: { type: "number" },
      currency: { type: "string" },
      assumptions: { type: "array", items: { type: "string" } },
      customerNotes: { type: "array", items: { type: "string" } },
    },
    required: [
      "title",
      "identifiedEquipment",
      "materials",
      "labor",
      "accessEquipment",
      "systemOffline",
      "materialsSubtotal",
      "laborSubtotalLow",
      "laborSubtotalHigh",
      "totalLow",
      "totalHigh",
      "currency",
      "assumptions",
      "customerNotes",
    ],
  },
} as const;
