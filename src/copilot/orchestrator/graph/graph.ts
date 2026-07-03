import { StateGraph, START, END } from "@langchain/langgraph";
import { OrchestratorStateAnnotation } from "./state";
import { routerNode } from "./nodes/router.node";
import { generalNode } from "./nodes/general.node";
import { estimateNode } from "./nodes/estimate.node";

/**
 * Multi-agent orchestrator as a LangGraph state machine:
 *
 *   START → router → (route === "estimate" ? estimate : general) → END
 *
 * The router classifies intent (honoring an explicit mode hint as a prior). Each
 * agent node dispatches custom events; the controller consumes `streamEvents` (v2)
 * and relays node lifecycle + custom events as SSE. Adding a future agent is a
 * three-line change: add a node, add it to the conditional map, extend the router.
 *
 * Stateless across requests (no checkpointer), so it is compiled once and reused.
 */
let compiled: ReturnType<ReturnType<typeof buildGraph>["compile"]> | null = null;

function buildGraph() {
  return new StateGraph(OrchestratorStateAnnotation)
    .addNode("router", routerNode)
    .addNode("general", generalNode)
    .addNode("estimate", estimateNode)
    .addEdge(START, "router")
    .addConditionalEdges("router", (s) => (s.route === "estimate" ? "estimate" : "general"), {
      estimate: "estimate",
      general: "general",
    })
    .addEdge("general", END)
    .addEdge("estimate", END);
}

export function getOrchestratorGraph() {
  if (!compiled) compiled = buildGraph().compile();
  return compiled;
}

/** Node names the controller treats as graph steps (for `node` SSE frames). */
export const ORCHESTRATOR_NODES = new Set(["router", "general", "estimate"]);

export type OrchestratorInput = {
  conversationId: string;
  userId: string;
  content: string;
  modeHint?: "estimate" | "general";
  timezone?: string;
  imageUrls?: string[];
  imageUrl?: string;
  imageBase64?: string;
  imageMimeType?: string;
  systemContext?: string;
  history?: { role: "user" | "assistant"; content: string }[];
};

/** Run the orchestrator and return a LangGraph v2 event stream. */
export function streamOrchestrator(input: OrchestratorInput, signal?: AbortSignal) {
  return getOrchestratorGraph().streamEvents(input, { version: "v2", signal });
}
