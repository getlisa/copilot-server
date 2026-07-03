import OpenAI from "openai";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import type { RunnableConfig } from "@langchain/core/runnables";
import logger from "../../../../lib/logger";
import { systemPrompt } from "../../../../lib/systemPrompt";
import { ZERO_USAGE, type Usage } from "../../../estimate/estimateService";
import { callStructured } from "../../../estimate/estimateService";
import type {
  CitationItem,
  CopilotBlock,
  FollowUpChip,
  SourceItem,
} from "../../responseContract";
import type { OrchestratorState } from "../state";

const openai = new OpenAI();

const GENERAL_MODEL = process.env.OPENAI_AGENT_MODEL || "gpt-5.4-mini";
const FOLLOWUP_MODEL = process.env.ORCHESTRATOR_ROUTER_MODEL || "gpt-5.4-nano";
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;
// Suggestion chips add one cheap call; on by default, set ORCHESTRATOR_FOLLOWUPS=0 to disable.
const FOLLOWUPS_ENABLED = process.env.ORCHESTRATOR_FOLLOWUPS !== "0";

function vectorStoreIds(): string[] {
  if (!VECTOR_STORE_ID) return [];
  return VECTOR_STORE_ID.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Build the Responses API `input` array from orchestrator state (context + history + turn). */
function buildResponsesInput(state: OrchestratorState): any[] {
  const input: any[] = [];

  if (state.systemContext) {
    input.push({
      role: "assistant",
      content: [{ type: "output_text", text: state.systemContext }],
    });
  }

  for (const turn of state.history ?? []) {
    input.push(
      turn.role === "assistant"
        ? { role: "assistant", content: [{ type: "output_text", text: turn.content }] }
        : { role: "user", content: [{ type: "input_text", text: turn.content }] }
    );
  }

  const imageItems = (state.imageUrls ?? [])
    .filter(Boolean)
    .map((url) => ({ type: "input_image", image_url: url }));

  input.push({
    role: "user",
    content: [
      { type: "input_text", text: state.content || "Please help with this." },
      ...imageItems,
    ],
  });

  return input;
}

function toUsage(u: any): Usage {
  if (!u) return ZERO_USAGE;
  return {
    promptTokens: u.input_tokens ?? 0,
    completionTokens: u.output_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
  };
}

/** Parse an NFPA/NEC/ICC/ASHRAE reference out of a cited filename/title, if present. */
function parseStandard(label: string): Partial<CitationItem> {
  const m = label.match(/\b(NFPA|NEC|ICC|ASHRAE|UL)\b[\s-]*([0-9]+[A-Za-z]?)?/i);
  if (!m) return {};
  return { standard: m[1].toUpperCase(), code: m[2] || undefined };
}

/**
 * Extract real citations + sources from the completed response's output annotations
 * (file_citation / url_citation). Provenance is real — no extra LLM call.
 */
function extractCitationsAndSources(output: any[]): { citations: CitationItem[]; sources: SourceItem[] } {
  const citations: CitationItem[] = [];
  const sources: SourceItem[] = [];
  const seenFile = new Set<string>();
  const seenUrl = new Set<string>();

  for (const item of output ?? []) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      const annotations = Array.isArray(part?.annotations) ? part.annotations : [];
      for (const ann of annotations) {
        if (ann?.type === "file_citation") {
          const title = ann.filename || ann.file_id || "Document";
          const key = `${ann.file_id ?? title}`;
          if (!seenFile.has(key)) {
            seenFile.add(key);
            sources.push({ type: "file", title, fileId: ann.file_id });
            const std = parseStandard(title);
            if (std.standard) citations.push({ ...std, title });
          }
        } else if (ann?.type === "url_citation") {
          const url = ann.url as string | undefined;
          const title = ann.title || url || "Source";
          const key = url ?? title;
          if (!seenUrl.has(key)) {
            seenUrl.add(key);
            sources.push({ type: "web", title, url });
            const std = parseStandard(title);
            citations.push({ ...std, title, url });
          }
        }
      }
    }
  }
  return { citations, sources };
}

const FOLLOWUP_SCHEMA = {
  name: "follow_ups",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      followUps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            label: { type: "string", description: "Short chip label (2-5 words)." },
            prompt: { type: "string", description: "The full question to send when tapped." },
          },
          required: ["id", "label", "prompt"],
        },
      },
    },
    required: ["followUps"],
  },
} as const;

/** Cheap nano pass that proposes up to 3 next-question suggestion chips. */
async function generateFollowUps(question: string, answer: string, signal?: AbortSignal): Promise<FollowUpChip[]> {
  try {
    const { raw } = await callStructured({
      system:
        "Given a field-service Q&A exchange, propose up to 3 short, relevant follow-up questions the technician is likely to ask next. Return them as suggestion chips. If none make sense, return an empty array.",
      userContent: `Question: ${question}\n\nAnswer: ${answer}`,
      jsonSchema: FOLLOWUP_SCHEMA,
      model: FOLLOWUP_MODEL,
      signal,
    });
    const items = (raw as any)?.followUps;
    if (Array.isArray(items)) {
      return items
        .filter((i) => i && typeof i.label === "string" && typeof i.prompt === "string")
        .slice(0, 3)
        .map((i, idx) => ({ id: i.id || `fu_${idx}`, label: i.label, prompt: i.prompt }));
    }
  } catch (err) {
    logger.warn("general node: follow-up generation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return [];
}

/**
 * General copilot node: the ClaraAgent replacement, rebuilt on the raw OpenAI
 * Responses API with hosted file_search + web_search. Streams text as `chunk`
 * custom events, surfaces tool calls, extracts real citations/sources from the
 * response annotations, optionally proposes follow-up chips, and returns the
 * assembled typed blocks.
 */
export async function generalNode(state: OrchestratorState, config?: RunnableConfig) {
  const tools: any[] = [];
  const vIds = vectorStoreIds();
  if (vIds.length > 0) tools.push({ type: "file_search", vector_store_ids: vIds });
  tools.push({ type: "web_search_preview" });

  const stream = (await openai.responses.create(
    {
      model: GENERAL_MODEL,
      instructions: systemPrompt,
      input: buildResponsesInput(state),
      tools,
      tool_choice: "auto",
      top_p: 0.8,
      max_output_tokens: 800,
      stream: true,
    },
    { signal: config?.signal }
  )) as any;

  let fullText = "";
  const toolsUsed: string[] = [];
  const seenTool = new Set<string>();
  let citations: CitationItem[] = [];
  let sources: SourceItem[] = [];
  let usage: Usage = ZERO_USAGE;

  const noteTool = async (kind?: string) => {
    const tool =
      kind === "file_search_call" ? "file_search" : kind === "web_search_call" ? "web_search" : undefined;
    if (tool && !seenTool.has(tool)) {
      seenTool.add(tool);
      toolsUsed.push(tool);
      await dispatchCustomEvent("tool_call", { tool }, config);
    }
  };

  for await (const ev of stream) {
    const type: string = ev?.type ?? "";
    if (type === "response.output_text.delta") {
      const delta: string = ev.delta ?? "";
      if (delta) {
        fullText += delta;
        await dispatchCustomEvent("chunk", { content: delta }, config);
      }
    } else if (type === "response.output_item.added" || type === "response.output_item.done") {
      await noteTool(ev.item?.type);
    } else if (type === "response.completed") {
      usage = toUsage(ev.response?.usage);
      const out = ev.response?.output ?? [];
      for (const item of out) await noteTool(item?.type);
      const extracted = extractCitationsAndSources(out);
      citations = extracted.citations;
      sources = extracted.sources;
    }
  }

  await dispatchCustomEvent("usage", usage, config);

  // Emit structured blocks (each its own named SSE frame) as soon as they're ready.
  const blocks: CopilotBlock[] = [{ kind: "markdown", text: fullText }];
  if (citations.length > 0) {
    blocks.push({ kind: "citations", items: citations });
    await dispatchCustomEvent("citations", { items: citations }, config);
  }
  if (sources.length > 0) {
    blocks.push({ kind: "sources", items: sources });
    await dispatchCustomEvent("sources", { items: sources }, config);
  }

  if (FOLLOWUPS_ENABLED && fullText.trim()) {
    const followUps = await generateFollowUps(state.content, fullText, config?.signal);
    if (followUps.length > 0) {
      blocks.push({ kind: "followUps", items: followUps });
      await dispatchCustomEvent("followUps", { items: followUps }, config);
    }
  }

  logger.info("general node: done", { chars: fullText.length, toolsUsed, citations: citations.length });

  // Note: the general node conveys its bubble text via `chunk` events (streamed),
  // not a `message` event — the controller's markdown block is built from the chunks.
  return {
    message: fullText,
    responseKind: "message" as const,
    blocks,
    toolsUsed,
    usage,
  };
}
