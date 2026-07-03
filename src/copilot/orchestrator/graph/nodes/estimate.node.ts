import type { RunnableConfig } from "@langchain/core/runnables";
import logger from "../../../../lib/logger";
import { getEstimateGraph } from "../../../estimate/graph/graph";
import type { EstimateInput } from "../../../estimate/estimateService";
import type { CopilotBlock } from "../../responseContract";
import type { OrchestratorState } from "../state";

/** Match the estimate engine's existing history window. */
const ESTIMATE_HISTORY_LIMIT = 8;

/**
 * Estimate agent = the EXISTING estimate graph embedded as a sub-node.
 *
 * We invoke the compiled estimate graph and THREAD `config` through, so its node
 * lifecycle (`identify`/`build_quote`/`ask_questions`) and custom events
 * (`identified`/`message`/`quote`/`questions`/`usage`) bubble up to the parent
 * `streamEvents` and are relayed by the controller unchanged. The estimate graph
 * itself is untouched.
 */
export async function estimateNode(state: OrchestratorState, config?: RunnableConfig) {
  const input: EstimateInput = {
    content: state.content,
    imageUrl: state.imageUrl ?? state.imageUrls?.[0],
    imageBase64: state.imageBase64,
    imageMimeType: state.imageMimeType,
    history: (state.history ?? []).slice(-ESTIMATE_HISTORY_LIMIT),
  };

  const result = (await getEstimateGraph().invoke(input as any, config)) as any;

  const message: string = result.message ?? "";
  const responseKind: "quote" | "questions" | "message" = result.responseKind ?? "message";
  const quote = result.quote ?? null;
  const questions = result.questions ?? [];
  const identification = result.identification ?? null;

  // Best-effort typed blocks (the controller appends messageId-dependent `actions`).
  const blocks: CopilotBlock[] = [];
  if (identification) blocks.push({ kind: "identified", data: identification });
  if (message) blocks.push({ kind: "markdown", text: message });
  if (responseKind === "quote" && quote) blocks.push({ kind: "quote", data: quote });
  if (responseKind === "questions" && questions.length) {
    blocks.push({ kind: "questions", data: { questions } });
  }

  logger.info("estimate node: done", { responseKind, hasQuote: Boolean(quote) });

  return {
    message,
    responseKind,
    quote,
    questions,
    blocks,
    usage: result.usage,
  };
}
