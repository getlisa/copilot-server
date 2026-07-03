import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import type { RunnableConfig } from "@langchain/core/runnables";
import logger from "../../../../lib/logger";
import { callStructured, type EstimateTurn } from "../../../estimate/estimateService";
import { ROUTER_SYSTEM_PROMPT, routeDecisionJsonSchema } from "../../orchestratorPrompt";
import type { OrchestratorState } from "../state";

const ROUTER_MODEL = process.env.ORCHESTRATOR_ROUTER_MODEL || "gpt-5.4-nano";

/** How many recent turns to give the classifier for follow-up continuity. */
const ROUTER_HISTORY_TAIL = 3;

type RouteDecision = { route: "estimate" | "general"; reason: string };

function isValidDecision(raw: unknown): raw is RouteDecision {
  const r = raw as any;
  return r && (r.route === "estimate" || r.route === "general") && typeof r.reason === "string";
}

/**
 * Router (supervisor) node. Classifies the user's latest message into an agent.
 * "Hint, not override": an explicit `modeHint` is fed to the LLM as a strong prior;
 * the model may still override it. If the classifier fails, fall back to the hint,
 * else `general`.
 */
export async function routerNode(state: OrchestratorState, config?: RunnableConfig) {
  const tail: EstimateTurn[] = (state.history ?? []).slice(-ROUTER_HISTORY_TAIL);

  const userContent = [
    state.modeHint ? `MODE HINT (explicit toggle from client): ${state.modeHint}` : "MODE HINT: none",
    `USER MESSAGE: ${state.content || "[photo only]"}`,
  ].join("\n");

  let decision: RouteDecision = {
    route: state.modeHint ?? "general",
    reason: state.modeHint ? `Fell back to mode hint: ${state.modeHint}` : "Defaulted to general.",
  };

  try {
    const { raw, usage } = await callStructured({
      system: ROUTER_SYSTEM_PROMPT,
      userContent,
      history: tail,
      jsonSchema: routeDecisionJsonSchema,
      model: ROUTER_MODEL,
      signal: config?.signal,
    });
    await dispatchCustomEvent("usage", usage, config);
    if (isValidDecision(raw)) {
      decision = raw;
    } else {
      logger.warn("router node: invalid decision, using fallback", { fallback: decision.route });
    }
  } catch (err) {
    logger.warn("router node: classification failed, using fallback", {
      error: err instanceof Error ? err.message : String(err),
      fallback: decision.route,
    });
  }

  logger.info("router node: decided", { route: decision.route, reason: decision.reason });
  await dispatchCustomEvent(
    "route",
    { route: decision.route, reason: decision.reason, source: "llm" },
    config
  );

  return { route: decision.route, routeReason: decision.reason };
}
