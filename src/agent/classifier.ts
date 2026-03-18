import OpenAI from "openai";
import logger from "../lib/logger";
import { ClassificationResult, QueryTheme } from "../types/agent.types";

const FAST_MODEL = process.env.OPENAI_FAST_MODEL ?? "gpt-4o-mini";

/** Minimum confidence required to trust the classification; below this falls back to technical_query */
const CONFIDENCE_THRESHOLD = 0.80;

const CLASSIFIER_SYSTEM_PROMPT = `You are a query classifier for Clara, a field service AI assistant for technicians working in HVAC, plumbing, electrical, and fire protection industries.

Classify the user message into exactly one theme:
- "greeting": casual greetings, thanks, how are you, small talk, acknowledgements
- "job_context": questions about current job details, address, scheduled time, visit number, job status, technician assignment, previous visits
- "technical_query": troubleshooting, error codes, equipment specs, repair procedures, safety standards, wiring, code compliance, product manuals
- "out_of_scope": anything completely unrelated to field service industries

Rules:
- If the user mentions an image or photo for analysis, classify as "technical_query"
- When in doubt between job_context and technical_query, choose "technical_query"
- "out_of_scope" only for clearly unrelated topics (sports, cooking, politics, etc.)

Respond with valid JSON only — no markdown, no extra text:
{
  "theme": "<theme>",
  "confidence": <0.0-1.0>,
  "reasoning": "<1 concise sentence>",
  "needsRag": <true|false>,
  "needsWebSearch": false,
  "needsJobContext": <true|false>
}`;

const FALLBACK_RESULT: ClassificationResult = {
  theme: "technical_query",
  confidence: 0,
  reasoning: "Classifier failed or low confidence — using safe fallback",
  needsRag: true,
  needsWebSearch: false,
  needsJobContext: true,
};

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

/**
 * Classifies a user query into a routing theme using a fast, small model.
 * @param userMessage  The raw user message text.
 * @param recentContext Optional short string of the last 1-2 conversation turns for context.
 * @returns ClassificationResult with theme, confidence, reasoning, and routing flags.
 */
export async function classifyQuery(
  userMessage: string,
  recentContext?: string
): Promise<ClassificationResult & { classifierTokens: { prompt: number; completion: number } }> {
  const startTime = Date.now();
  const client = getClient();

  logger.debug("Classifying query", {
    model: FAST_MODEL,
    queryPreview: userMessage.slice(0, 80),
    hasContext: !!recentContext,
  });

  try {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
    ];

    if (recentContext) {
      messages.push({ role: "user", content: `Recent conversation context:\n${recentContext}` });
      messages.push({ role: "assistant", content: "Got it." });
    }

    messages.push({ role: "user", content: userMessage });

    const response = await client.chat.completions.create({
      model: FAST_MODEL,
      messages,
      temperature: 0,
      max_tokens: 150,
      response_format: { type: "json_object" },
    });

    const classifierTokens = {
      prompt: response.usage?.prompt_tokens ?? 0,
      completion: response.usage?.completion_tokens ?? 0,
    };

    const raw = response.choices[0]?.message?.content ?? "{}";
    let parsed: Partial<ClassificationResult>;

    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn("Classifier returned invalid JSON, falling back", { raw });
      return { ...FALLBACK_RESULT, classifierTokens };
    }

    const validThemes: QueryTheme[] = ["greeting", "job_context", "technical_query", "out_of_scope"];
    if (!parsed.theme || !validThemes.includes(parsed.theme as QueryTheme)) {
      logger.warn("Classifier returned invalid theme, falling back", { parsed });
      return { ...FALLBACK_RESULT, classifierTokens };
    }

    const result: ClassificationResult = {
      theme: parsed.theme as QueryTheme,
      confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      needsRag: Boolean(parsed.needsRag),
      needsWebSearch: false,
      needsJobContext: Boolean(parsed.needsJobContext),
    };

    if (result.confidence < CONFIDENCE_THRESHOLD) {
      logger.warn("Low classifier confidence, falling back to technical_query", {
        originalTheme: result.theme,
        confidence: result.confidence,
      });
      return {
        ...FALLBACK_RESULT,
        classifierTokens,
        reasoning: result.reasoning,
      };
    }

    return { ...result, classifierTokens };
  } catch (error) {
    logger.error("Classifier error, falling back to technical_query", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...FALLBACK_RESULT, classifierTokens: { prompt: 0, completion: 0 } };
  }
}
