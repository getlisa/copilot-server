import { StateGraph, START, END } from "@langchain/langgraph";
import { EstimateStateAnnotation } from "./state";
import { identifyNode, buildQuoteNode, askQuestionsNode } from "./nodes";
import type { EstimateInput } from "../estimateService";

/**
 * Estimate workflow as a LangGraph state machine:
 *
 *   START → identify → (canPrice ? build_quote : ask_questions) → END
 *
 * The graph is stateless across requests, so it's compiled once. Nodes dispatch
 * custom events (identified / message / quote / questions / usage); the controller
 * consumes `streamEvents` (v2) and relays node lifecycle + custom events as SSE.
 */
let compiled: ReturnType<ReturnType<typeof buildGraph>["compile"]> | null = null;

function buildGraph() {
  return new StateGraph(EstimateStateAnnotation)
    .addNode("identify", identifyNode)
    .addNode("build_quote", buildQuoteNode)
    .addNode("ask_questions", askQuestionsNode)
    .addEdge(START, "identify")
    .addConditionalEdges(
      "identify",
      (s) => (s.canPrice ? "build_quote" : "ask_questions"),
      { build_quote: "build_quote", ask_questions: "ask_questions" }
    )
    .addEdge("build_quote", END)
    .addEdge("ask_questions", END);
}

export function getEstimateGraph() {
  if (!compiled) compiled = buildGraph().compile();
  return compiled;
}

/** Node names the controller treats as graph steps (for `node` SSE frames). */
export const ESTIMATE_NODES = new Set(["identify", "build_quote", "ask_questions"]);

/** Run the graph and return a LangGraph v2 event stream. */
export function streamEstimateGraph(input: EstimateInput, signal?: AbortSignal) {
  return getEstimateGraph().streamEvents(input, { version: "v2", signal });
}
