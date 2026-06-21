import OpenAI from "openai";
import logger from "../../lib/logger";
import { ESTIMATE_SYSTEM_PROMPT } from "./estimatePrompt";
import {
  estimateQuoteJsonSchema,
  estimateQuoteSchema,
  type EstimateQuote,
} from "./estimateQuoteSchema";

/**
 * DEMO-ONLY estimate engine. Built directly on the `openai` SDK (no LangChain,
 * no copilot graph) so it stands alone and runs on a clean `main`. It mirrors the
 * vision pattern already used in `src/lib/imageSummary.ts`.
 */

const openai = new OpenAI();

// Vision- and json_schema-capable model. Falls back through the same chain the
// rest of the app uses, defaulting to a current multimodal model.
const ESTIMATE_MODEL =
  process.env.ESTIMATE_MODEL || process.env.OPENAI_AGENT_MODEL || "gpt-4o";

export interface EstimateTurn {
  role: "user" | "assistant";
  content: string;
}

export interface StreamEstimateInput {
  content?: string;
  imageUrl?: string;
  imageBase64?: string;
  imageMimeType?: string;
  history?: EstimateTurn[];
}

export interface StreamEstimateHandlers {
  onChunk?: (delta: string) => void;
}

export interface StreamEstimateResult {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** Build the multimodal user content (text + optional image) for the turn. */
function buildUserContent(input: StreamEstimateInput): any {
  const parts: any[] = [];
  const text =
    input.content?.trim() ||
    "Identify the part in this photo, decide repair vs. replace, and give me a cost estimate.";
  parts.push({ type: "text", text });

  const imageUrl =
    input.imageUrl ||
    (input.imageBase64
      ? `data:${input.imageMimeType || "image/jpeg"};base64,${input.imageBase64}`
      : undefined);

  if (imageUrl) {
    parts.push({ type: "image_url", image_url: { url: imageUrl } });
  }

  // If there's no image, a plain string keeps the request simple.
  return imageUrl ? parts : text;
}

/**
 * Stream the markdown estimate. Relays token deltas through `onChunk` and returns
 * the full text plus token usage.
 */
export async function streamEstimate(
  input: StreamEstimateInput,
  handlers: StreamEstimateHandlers,
  signal?: AbortSignal
): Promise<StreamEstimateResult> {
  const messages: any[] = [
    { role: "system", content: ESTIMATE_SYSTEM_PROMPT },
    ...(input.history ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: buildUserContent(input) },
  ];

  const stream = await openai.chat.completions.create(
    {
      model: ESTIMATE_MODEL,
      stream: true,
      stream_options: { include_usage: true },
      messages,
    },
    { signal }
  );

  let text = "";
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for await (const part of stream) {
    const delta = part.choices?.[0]?.delta?.content ?? "";
    if (delta) {
      text += delta;
      handlers.onChunk?.(delta);
    }
    if (part.usage) {
      usage.promptTokens = part.usage.prompt_tokens ?? 0;
      usage.completionTokens = part.usage.completion_tokens ?? 0;
      usage.totalTokens = part.usage.total_tokens ?? 0;
    }
  }

  return { text, usage };
}

/**
 * Produce the structured quote object from the already-generated narrative. This
 * is a second, text-only call (the image is NOT re-sent) that asks the model to
 * normalize its own estimate into the strict JSON schema for the mobile quote card.
 * Returns null if the structured pass fails — the streamed markdown still stands.
 */
export async function extractQuote(
  narrative: string,
  originalRequest?: string,
  signal?: AbortSignal
): Promise<EstimateQuote | null> {
  try {
    const completion = await openai.chat.completions.create(
      {
        model: ESTIMATE_MODEL,
        messages: [
          {
            role: "system",
            content:
              "Convert the field-service cost estimate below into the structured JSON quote. " +
              "Use only figures present in or directly implied by the estimate. Ensure each " +
              "line item's amount equals quantity * unitCost, subtotal equals the sum of line " +
              "item amounts, and total reflects the estimate. Currency is USD unless stated.",
          },
          {
            role: "user",
            content:
              (originalRequest ? `Technician request: ${originalRequest}\n\n` : "") +
              `Estimate to structure:\n${narrative}`,
          },
        ],
        response_format: { type: "json_schema", json_schema: estimateQuoteJsonSchema },
      },
      { signal }
    );

    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) return null;

    const parsed = estimateQuoteSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.warn("Estimate quote schema validation failed", {
        error: parsed.error.message,
      });
      return null;
    }
    return parsed.data;
  } catch (error) {
    logger.warn("Estimate quote extraction failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
