import { getOrchestratorGraph, type OrchestratorInput } from "./graph/graph";
import { contextService } from "./contextService";
import type { CopilotBlock, CopilotResponseKind } from "./responseContract";
import type { EstimateQuote, FollowUpQuestion } from "../estimate/estimateQuoteSchema";
import type { Usage } from "../estimate/estimateService";

export interface OrchestratorResult {
  content: string;
  responseKind: CopilotResponseKind;
  route: "estimate" | "general";
  routeReason: string;
  blocks: CopilotBlock[];
  quote: EstimateQuote | null;
  questions: FollowUpQuestion[];
  toolsUsed: string[];
  usage: Usage;
}

export interface RunInput {
  conversationId: string;
  userId: string;
  content: string;
  modeHint?: "estimate" | "general";
  timezone?: string;
  imageUrls?: string[];
  imageUrl?: string;
  imageBase64?: string;
  imageMimeType?: string;
}

/**
 * Run the orchestrator to completion (no streaming) and return the final result.
 * Used by the non-streaming `/send` endpoint and the voice agent. Assembles the
 * conversation context the same way the streaming controller does.
 */
export async function runToCompletion(
  params: RunInput,
  signal?: AbortSignal
): Promise<OrchestratorResult> {
  const { systemContext, history } = await contextService.build(
    params.conversationId,
    params.timezone
  );

  const input: OrchestratorInput = {
    conversationId: params.conversationId,
    userId: params.userId,
    content: params.content,
    modeHint: params.modeHint,
    timezone: params.timezone,
    imageUrls: params.imageUrls ?? [],
    imageUrl: params.imageUrl,
    imageBase64: params.imageBase64,
    imageMimeType: params.imageMimeType,
    systemContext,
    history,
  };

  const state = (await getOrchestratorGraph().invoke(input, { signal })) as any;

  return {
    content: state.message ?? "",
    responseKind: state.responseKind ?? "message",
    route: state.route ?? "general",
    routeReason: state.routeReason ?? "",
    blocks: state.blocks ?? [],
    quote: state.quote ?? null,
    questions: state.questions ?? [],
    toolsUsed: state.toolsUsed ?? [],
    usage: state.usage,
  };
}
