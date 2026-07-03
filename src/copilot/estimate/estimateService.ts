import OpenAI from "openai";
import logger from "../../lib/logger";

/**
 * Shared OpenAI plumbing for the estimate LangGraph nodes. Each node calls
 * `callStructured` with its own system prompt + strict json_schema and validates
 * the result with its zod schema. Built on the raw `openai` SDK (no @langchain/openai)
 * so the node layer stays dependency-light; the graph wiring lives in ./graph.
 */

const openai = new OpenAI();

// Vision- and json_schema-capable model. Same resolution as the rest of the app.
export const ESTIMATE_MODEL =
  process.env.ESTIMATE_MODEL || process.env.OPENAI_AGENT_MODEL || "gpt-4o";

export interface EstimateTurn {
  role: "user" | "assistant";
  content: string;
}

export interface EstimateInput {
  content?: string;
  imageUrl?: string;
  imageBase64?: string;
  imageMimeType?: string;
  history?: EstimateTurn[];
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** Build the multimodal user content (text + optional image) for a turn. */
export function buildUserContent(input: EstimateInput): any {
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
 * One structured (json_schema) chat-completion call. Returns the parsed JSON
 * (unvalidated — the caller validates with its zod schema) plus token usage.
 */
export async function callStructured(opts: {
  system: string;
  userContent: any;
  history?: EstimateTurn[];
  jsonSchema: any;
  signal?: AbortSignal;
  /** Override the model (e.g. a cheap classifier for the router). Defaults to ESTIMATE_MODEL. */
  model?: string;
}): Promise<{ raw: unknown; usage: Usage }> {
  const messages: any[] = [
    { role: "system", content: opts.system },
    ...(opts.history ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: opts.userContent },
  ];

  const completion = await openai.chat.completions.create(
    {
      model: opts.model ?? ESTIMATE_MODEL,
      messages,
      response_format: { type: "json_schema", json_schema: opts.jsonSchema },
    },
    { signal: opts.signal }
  );

  const usage: Usage = {
    promptTokens: completion.usage?.prompt_tokens ?? 0,
    completionTokens: completion.usage?.completion_tokens ?? 0,
    totalTokens: completion.usage?.total_tokens ?? 0,
  };

  const rawText = completion.choices?.[0]?.message?.content;
  let raw: unknown = null;
  if (rawText) {
    try {
      raw = JSON.parse(rawText);
    } catch (err) {
      logger.warn("Estimate structured-output JSON parse failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { raw, usage };
}
