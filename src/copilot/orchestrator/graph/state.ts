import { Annotation } from "@langchain/langgraph";
import { ZERO_USAGE, addUsage, type Usage } from "../../estimate/estimateService";
import type { EstimateQuote, FollowUpQuestion } from "../../estimate/estimateQuoteSchema";
import type { CopilotBlock, CopilotResponseKind } from "../responseContract";

/** A plain conversation turn — superset-compatible with the estimate `EstimateTurn`. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Last-write-wins, but keep the previous value when a node returns undefined. */
const keep = <T>(a: T, b: T | undefined) => (b === undefined ? a : b);

/** Merge string arrays, de-duplicated (used for tool names). */
const mergeUnique = (a: string[], b: string[] | undefined) =>
  b === undefined ? a : Array.from(new Set([...a, ...b]));

/**
 * Orchestrator state. The controller fills the inputs (incl. pre-assembled
 * `systemContext` + `history` from ContextService); the router fills `route`;
 * the selected agent fills the output channels. `usage` accumulates across nodes.
 */
export const OrchestratorStateAnnotation = Annotation.Root({
  // --- inputs ---
  conversationId: Annotation<string>(),
  userId: Annotation<string>(),
  content: Annotation<string>(),
  modeHint: Annotation<"estimate" | "general" | undefined>(),
  timezone: Annotation<string | undefined>(),
  // image inputs (unified superset of both surfaces)
  imageUrls: Annotation<string[]>({ reducer: keep, default: () => [] }),
  imageUrl: Annotation<string | undefined>(),
  imageBase64: Annotation<string | undefined>(),
  imageMimeType: Annotation<string | undefined>(),
  // pre-assembled context (built in the controller via ContextService)
  systemContext: Annotation<string>({ reducer: keep, default: () => "" }),
  history: Annotation<ChatTurn[]>({ reducer: keep, default: () => [] }),

  // --- routing ---
  route: Annotation<"estimate" | "general">({ reducer: keep, default: () => "general" }),
  routeReason: Annotation<string>({ reducer: keep, default: () => "" }),

  // --- outputs ---
  message: Annotation<string>({ reducer: keep, default: () => "" }),
  responseKind: Annotation<CopilotResponseKind>({ reducer: keep, default: () => "message" }),
  blocks: Annotation<CopilotBlock[]>({ reducer: keep, default: () => [] }),
  quote: Annotation<EstimateQuote | null>({ reducer: keep, default: () => null }),
  questions: Annotation<FollowUpQuestion[]>({ reducer: keep, default: () => [] }),
  toolsUsed: Annotation<string[]>({ reducer: mergeUnique, default: () => [] }),
  usage: Annotation<Usage>({ reducer: addUsage, default: () => ZERO_USAGE }),
});

export type OrchestratorState = typeof OrchestratorStateAnnotation.State;
