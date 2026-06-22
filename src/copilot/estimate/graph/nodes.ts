import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import type { RunnableConfig } from "@langchain/core/runnables";
import logger from "../../../lib/logger";
import { IDENTIFY_SYSTEM_PROMPT, BUILD_QUOTE_SYSTEM_PROMPT } from "../estimatePrompt";
import { buildUserContent, callStructured } from "../estimateService";
import {
  identifyResultSchema,
  identifyResultJsonSchema,
  quoteResultSchema,
  quoteResultJsonSchema,
  type FollowUpQuestion,
} from "../estimateQuoteSchema";
import type { EstimateState } from "./state";

/**
 * Estimate graph nodes. Each does real work and dispatches the matching custom
 * event (identified / message / quote / questions) which the controller relays as
 * SSE. Node start/end frames come from the graph's on_chain_start/end events.
 */

const GENERIC_QUESTION: FollowUpQuestion = {
  id: "describe",
  question: "Can you tell me a bit more about the equipment and what's wrong?",
  options: [],
  allowOther: true,
};

/** identify (vision): what is it + can we price it (else the required questions). */
export async function identifyNode(state: EstimateState, config?: RunnableConfig) {
  const { raw, usage } = await callStructured({
    system: IDENTIFY_SYSTEM_PROMPT,
    userContent: buildUserContent(state),
    history: state.history,
    jsonSchema: identifyResultJsonSchema,
    signal: config?.signal,
  });

  const parsed = identifyResultSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn("identify node: validation failed", { error: parsed.error.message });
    await dispatchCustomEvent("usage", usage, config);
    await dispatchCustomEvent("identified", null, config);
    return {
      canPrice: false,
      questions: [GENERIC_QUESTION],
      message: "I need a bit more detail to estimate this.",
      usage,
    };
  }

  const r = parsed.data;
  logger.info("identify node: done", { canPrice: r.canPrice, category: r.identification.category });
  await dispatchCustomEvent("usage", usage, config);
  await dispatchCustomEvent("identified", r.identification, config);

  return {
    identification: r.identification,
    canPrice: r.canPrice,
    questions: r.questions,
    message: r.message,
    usage,
  };
}

/** build_quote (text): price the identified job against the pricebook. */
export async function buildQuoteNode(state: EstimateState, config?: RunnableConfig) {
  const ctx = [
    state.content ? `Technician request: ${state.content}` : "",
    `Identified equipment: ${JSON.stringify(state.identification)}`,
    "Build the full quotation for this job.",
  ]
    .filter(Boolean)
    .join("\n");

  const { raw, usage } = await callStructured({
    system: BUILD_QUOTE_SYSTEM_PROMPT,
    userContent: ctx,
    history: state.history,
    jsonSchema: quoteResultJsonSchema,
    signal: config?.signal,
  });

  const parsed = quoteResultSchema.safeParse(raw);
  const quoteValid =
    parsed.success &&
    parsed.data.quote.status === "estimate" &&
    parsed.data.quote.lineItems.length > 0 &&
    Number.isFinite(parsed.data.quote.total) &&
    parsed.data.quote.total > 0;

  await dispatchCustomEvent("usage", usage, config);

  if (!quoteValid) {
    logger.warn("build_quote node: invalid quote, falling back to message");
    const msg = "I couldn't put together a priced estimate for this one — could you add a bit more detail?";
    await dispatchCustomEvent("message", { content: msg }, config);
    return { responseKind: "message" as const, message: msg, usage };
  }

  const { quote, message } = parsed.data;
  logger.info("build_quote node: done", { total: quote.total, lineItems: quote.lineItems.length });
  await dispatchCustomEvent("message", { content: message }, config);
  await dispatchCustomEvent("quote", quote, config);

  return { quote, message, responseKind: "quote" as const, usage };
}

/** ask_questions: surface the required follow-ups from identify (no LLM call). */
export async function askQuestionsNode(state: EstimateState, config?: RunnableConfig) {
  const questions = state.questions.length ? state.questions : [GENERIC_QUESTION];
  const message = state.message || "To price this accurately I need a couple of details:";

  logger.info("ask_questions node: done", { count: questions.length });
  await dispatchCustomEvent("message", { content: message }, config);
  await dispatchCustomEvent("questions", { questions }, config);

  return { questions, message, responseKind: "questions" as const };
}
