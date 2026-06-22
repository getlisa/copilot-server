import OpenAI from "openai";
import logger from "../../lib/logger";
import { ESTIMATE_SYSTEM_PROMPT } from "./estimatePrompt";
import {
  estimateResultJsonSchema,
  estimateResultSchema,
  type EstimateResult,
} from "./estimateQuoteSchema";

/**
 * DEMO-ONLY estimate engine. Built directly on the `openai` SDK (no LangChain,
 * no copilot graph) so it stands alone and runs on a clean `main`. It mirrors the
 * vision pattern in `src/lib/imageSummary.ts`.
 *
 * A single vision + structured-output call returns the typed `EstimateResult`
 * (`responseKind` + `message` + `quote` + `questions`). The controller maps that
 * to SSE frames — there is no separate markdown stream, so the UI never receives
 * the estimate twice.
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

export interface GenerateEstimateInput {
  content?: string;
  imageUrl?: string;
  imageBase64?: string;
  imageMimeType?: string;
  history?: EstimateTurn[];
}

export interface GenerateEstimateResult {
  result: EstimateResult;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** Build the multimodal user content (text + optional image) for the turn. */
function buildUserContent(input: GenerateEstimateInput): any {
  const text =
    input.content?.trim() ||
    "Identify the part in this photo, decide repair vs. replace, and give me a cost estimate.";

  const imageUrl =
    input.imageUrl ||
    (input.imageBase64
      ? `data:${input.imageMimeType || "image/jpeg"};base64,${input.imageBase64}`
      : undefined);

  if (!imageUrl) return text; // plain string keeps a text-only request simple

  return [
    { type: "text", text },
    { type: "image_url", image_url: { url: imageUrl } },
  ];
}

/**
 * Run the estimator once and return the typed result. The model decides
 * `responseKind` ("quote" | "questions" | "message") and fills the matching
 * payload; the others are left empty/zeroed.
 */
export async function generateEstimate(
  input: GenerateEstimateInput,
  signal?: AbortSignal
): Promise<GenerateEstimateResult> {
  const messages: any[] = [
    { role: "system", content: ESTIMATE_SYSTEM_PROMPT },
    ...(input.history ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: buildUserContent(input) },
  ];

  const completion = await openai.chat.completions.create(
    {
      model: ESTIMATE_MODEL,
      messages,
      response_format: { type: "json_schema", json_schema: estimateResultJsonSchema },
    },
    { signal }
  );

  const usage = {
    promptTokens: completion.usage?.prompt_tokens ?? 0,
    completionTokens: completion.usage?.completion_tokens ?? 0,
    totalTokens: completion.usage?.total_tokens ?? 0,
  };

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) {
    return { result: fallbackResult("I couldn't generate an estimate just now. Please try again."), usage };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("Estimate result JSON parse failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { result: fallbackResult(raw), usage };
  }

  const validated = estimateResultSchema.safeParse(parsed);
  if (!validated.success) {
    logger.warn("Estimate result schema validation failed", { error: validated.error.message });
    return { result: fallbackResult(typeof (parsed as any)?.message === "string" ? (parsed as any).message : raw), usage };
  }

  return { result: validated.data, usage };
}

/** Build a safe "message" result when structured output is unavailable. */
function fallbackResult(message: string): EstimateResult {
  return {
    responseKind: "message",
    message,
    questions: [],
    quote: {
      status: "needs_info",
      title: "",
      identifiedEquipment: { brand: "", model: "", category: "", issue: "", decision: "repair", confidence: 0 },
      lineItems: [],
      materialsServicesSubtotal: 0,
      laborSubtotal: 0,
      taxOther: 0,
      total: 0,
      currency: "USD",
      assumptions: [],
      customerNotes: [],
    },
  };
}
