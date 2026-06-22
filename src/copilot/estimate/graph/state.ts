import { Annotation } from "@langchain/langgraph";
import { ZERO_USAGE, addUsage, type EstimateTurn, type Usage } from "../estimateService";
import type {
  EstimateQuote,
  FollowUpQuestion,
  IdentifyResult,
} from "../estimateQuoteSchema";

type Identification = IdentifyResult["identification"];

/** Last-write-wins, but keep the previous value when a node returns undefined. */
const keep = <T>(a: T, b: T | undefined) => (b === undefined ? a : b);

/**
 * Shared state for the estimate graph. Inputs are set at invoke; the nodes fill the
 * working channels. `usage` accumulates token usage across nodes.
 */
export const EstimateStateAnnotation = Annotation.Root({
  // inputs
  content: Annotation<string | undefined>(),
  imageUrl: Annotation<string | undefined>(),
  imageBase64: Annotation<string | undefined>(),
  imageMimeType: Annotation<string | undefined>(),
  history: Annotation<EstimateTurn[]>({ reducer: keep, default: () => [] }),
  // working
  identification: Annotation<Identification | null>({ reducer: keep, default: () => null }),
  canPrice: Annotation<boolean>({ reducer: keep, default: () => false }),
  questions: Annotation<FollowUpQuestion[]>({ reducer: keep, default: () => [] }),
  quote: Annotation<EstimateQuote | null>({ reducer: keep, default: () => null }),
  message: Annotation<string>({ reducer: keep, default: () => "" }),
  responseKind: Annotation<"quote" | "questions" | "message">({ reducer: keep, default: () => "message" }),
  usage: Annotation<Usage>({ reducer: addUsage, default: () => ZERO_USAGE }),
});

export type EstimateState = typeof EstimateStateAnnotation.State;
