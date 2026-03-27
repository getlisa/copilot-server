import {
  Agent,
  AgentInputItem,
  run,
  RunItem,
  RunItemStreamEvent,
  RunRawModelStreamEvent,
  InputGuardrailTripwireTriggered,
  ModelBehaviorError,
} from "@openai/agents";
import {
  fileSearchTool,
  setDefaultOpenAIKey,
  webSearchTool,
} from "@openai/agents-openai";
import {
  AIAgent,
  AgentContext,
  AgentResponse,
  AgentStreamCallbacks,
  ClassificationResult,
  QueryTheme,
} from "../types/agent.types";
import { messageRepository } from "../api/repositories/message.repository";
import logger from "../lib/logger";
import {
  systemPrompt,
  greetingSystemPrompt,
  jobContextSystemPrompt,
  generalQuerySystemPrompt,
} from "../lib/systemPrompt";
import { Message } from "../types/conversation.types";
import { countTokensForMessages } from "../lib/tokenizer";
import prisma from "../lib/prisma";
import { getJobContextTool } from "./tools/GetJobContextTool";
import { Classifier } from "./classifier";
import { technicalManualTool } from "./tools/RagTool";


type AgentRunContext = {
  conversationId: string;
  userId: string;
  timezone?: string;
};

type ImageItem = {
  type: "input_image";
  image: string;
};

const DEFAULT_MODEL = process.env.OPENAI_AGENT_MODEL ?? "gpt-5.4-mini-2026-03-17";
const FAST_MODEL = process.env.OPENAI_FAST_MODEL ?? "gpt-4o-mini";
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;
const HISTORY_LIMIT = 15;
const QDRANT_KB_ENABLED = Boolean(
  process.env.QDRANT_CLUSTER_URL?.trim() && process.env.QDRANT_COLLECTION_NAME?.trim()
);
const technicalTools: unknown[] = [];

if (QDRANT_KB_ENABLED) {
  technicalTools.push(technicalManualTool);
  logger.info("Technical agent: using Qdrant (technical_manual_tool) for knowledge base search");
} else {
  logger.warn(
    "No knowledge base configured: set QDRANT_CLUSTER_URL + QDRANT_COLLECTION_NAME for Qdrant, or VECTOR_STORE_ID for OpenAI file search"
  );
}

// else if (VECTOR_STORE_ID) {
//   const vectorStoreIds = VECTOR_STORE_ID.split(",")
//     .map((id) => id.trim())
//     .filter(Boolean);
//   if (vectorStoreIds.length > 0) {
//     technicalTools.push(fileSearchTool(vectorStoreIds));
//     logger.info("Technical agent: using file_search tool for knowledge base search");
//   }
// }

technicalTools.push(webSearchTool({ searchContextSize: "medium" }) as any);
technicalTools.push(getJobContextTool);

const OUT_OF_SCOPE_RESPONSE =
  "I'm Clara, your field service AI assistant. I'm specialized in HVAC, plumbing, electrical, and fire protection. Please ask me about your current job or any technical field service topics — I'm happy to help!";

export class ClaraAgent implements AIAgent {
  private static readonly STREAM_MAX_ATTEMPTS = 3;
  private static readonly STREAM_RETRY_DELAY_MS = 350;

  private greetingAgent: Agent<AgentRunContext>;
  private jobContextAgent: Agent<AgentRunContext>;
  private technicalAgent: Agent<AgentRunContext>;
  private generalAgent: Agent<AgentRunContext>;
  /** Shared classifier + OpenAI client — one per ClaraAgent instance, not per message */
  private readonly classifier = new Classifier();
  private lastInteractionTs = Date.now();

  constructor() {
    const { greeting, jobContext, technical, general } = this.buildAgents();
    this.greetingAgent = greeting;
    this.jobContextAgent = jobContext;
    this.technicalAgent = technical;
    this.generalAgent = general;
  }

  async init(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required");
    }
    setDefaultOpenAIKey(apiKey);
  }

  private buildAgents(): {
    greeting: Agent<AgentRunContext>;
    jobContext: Agent<AgentRunContext>;
    technical: Agent<AgentRunContext>;
    general: Agent<AgentRunContext>;
  } {
    const greeting = new Agent<AgentRunContext>({
      name: "Clara - Greeting",
      instructions: greetingSystemPrompt,
      model: FAST_MODEL,
      modelSettings: {
        topP: 0.9,
        maxTokens: 200,
        toolChoice: "none",
        truncation: "auto",
      },
      tools: [],
    });

    const jobContext = new Agent<AgentRunContext>({
      name: "Clara - Job Context",
      instructions: jobContextSystemPrompt,
      model: FAST_MODEL,
      modelSettings: {
        temperature: 0.6,
        topP: 0.9,
        maxTokens: 500,
        toolChoice: "required",
        truncation: "auto",
      },
      tools: [getJobContextTool],
    });

    // const technicalTools: (ReturnType<typeof fileSearchTool> | typeof getJobContextTool)[] = [];
    // if (VECTOR_STORE_ID) {
    //   const vectorStoreIds = VECTOR_STORE_ID.split(",")
    //     .map((id) => id.trim())
    //     .filter(Boolean);
    //   if (vectorStoreIds.length > 0) {
    //     technicalTools.push(fileSearchTool(vectorStoreIds));
    //   }
    // }
    // technicalTools.push(webSearchTool({ searchContextSize: "medium" }) as any);
    // technicalTools.push(getJobContextTool);

    const technicalTools = [getJobContextTool, technicalManualTool, webSearchTool({ searchContextSize: "medium" })];

    const technical = new Agent<AgentRunContext>({
      name: "Clara - Technical",
      instructions: systemPrompt,
      model: DEFAULT_MODEL,
      modelSettings: {
        topP: 0.8,
        maxTokens: 800,
        toolChoice: "required",
        parallelToolCalls: true,
        truncation: "auto",
      },
      tools: technicalTools,
    });

    const general = new Agent<AgentRunContext>({
      name: "Clara - General",
      instructions: generalQuerySystemPrompt,
      model: FAST_MODEL,
      modelSettings: {
        topP: 0.9,
        maxTokens: 400,
        toolChoice: "none",
        truncation: "auto",
      },
      tools: [],
    });

    return { greeting, jobContext, technical, general };
  }

  async processMessage(
    text: string,
    context: AgentContext,
    callbacks?: AgentStreamCallbacks
  ): Promise<AgentResponse> {
    if (!text.trim()) {
      throw new Error("Empty message");
    }

    const startTime = Date.now();

    logger.info(`▶ USER: "${text.slice(0, 200)}${text.length > 200 ? "…" : ""}"`, {
      conversationId: context.conversationId,
      userId: context.userId,
    });

    const [recentMessages, profile] = await Promise.all([
      messageRepository.getLastMessages(context.conversationId, HISTORY_LIMIT),
      this.getTechnicianProfile(context.conversationId),
    ]);

    const classifierRecentContext = this.formatClassifierRecentContext(recentMessages, text);

    const [classificationResult, history] = await Promise.all([
      this.classifier.classifyQuery(text, classifierRecentContext),
      Promise.resolve(this.assembleHistoryFromMessages(recentMessages, profile)),
    ]);

    const agent = this.selectAgent(classificationResult.theme);
    logger.info(`✦ CLASSIFIED: ${classificationResult.theme} (${Math.round(classificationResult.confidence * 100)}%) → ${agent.name}`, {
      conversationId: context.conversationId,
      reasoning: classificationResult.reasoning,
      classifierMs: `${Date.now() - startTime}ms`,
    });

    callbacks?.onClassification?.(classificationResult);

    const messages: AgentInputItem[] = [...history, this.toUserItem(text)] as AgentInputItem[];

    return this.runAgent(agent, messages, context, callbacks, classificationResult);
  }

  private selectAgent(theme: QueryTheme): Agent<AgentRunContext> {
    switch (theme) {
      case "greeting":
        return this.greetingAgent;
      case "job_context":
        return this.jobContextAgent;
      case "general_query":
        return this.generalAgent;
      case "technical_query":
      default:
        return this.technicalAgent;
    }
  }

  /**
   * Accepts inline image data (base64 or data URLs) to avoid external hosting.
   * Images always route to the technical agent.
   */
  async processMessageWithImages(
    text: string,
    images: string[],
    context: AgentContext,
    callbacks?: AgentStreamCallbacks
  ): Promise<AgentResponse> {
    if (!text.trim()) {
      throw new Error("Empty message");
    }

    const imageItems = images
      .filter(Boolean)
      .map((url: string) => url.trim())
      .filter((url: string) => url.length > 0)
      .map((url: string) => ({ type: "input_image", image: url }) as ImageItem);

    if (imageItems.length === 0) {
      throw new Error("No valid image URLs provided");
    }
    const userMessage: AgentInputItem = {
      role: "user",
      content: [{ type: "input_text", text: text }, ...imageItems],
    };

    const messages: AgentInputItem[] = [userMessage];
    const promptTokens = countTokensForMessages(messages, DEFAULT_MODEL);
    logger.debug("Image message prompt tokens", { promptTokens });

    // Images always go to the technical agent
    const imageClassification: ClassificationResult & { classifierTokens: { prompt: number; completion: number } } = {
      theme: "technical_query",
      confidence: 1,
      reasoning: "Image message always routes to technical agent",
      needsRag: true,
      needsWebSearch: false,
      needsJobContext: false,
      classifierTokens: { prompt: 0, completion: 0 },
    };

    callbacks?.onClassification?.(imageClassification);

    return this.runAgent(this.technicalAgent, messages, context, callbacks, imageClassification, { promptTokens });
  }

  async dispose(): Promise<void> {
    logger.info("Clara agent disposed");
  }

  getLastInteraction(): number {
    return this.lastInteractionTs;
  }

  getAssistantId(): string | undefined {
    return undefined;
  }

  /**
   * Builds a short transcript for the query classifier so elliptical follow-ups
   * ("give me the checklist") route using prior turns, not the latest line alone.
   */
  private formatClassifierRecentContext(recent: Message[], currentUserText: string): string | undefined {
    if (recent.length === 0) return undefined;

    const last = recent[recent.length - 1];
    const prior =
      last?.senderType === "USER" && last.content?.trim() === currentUserText.trim()
        ? recent.slice(0, -1)
        : recent;

    if (prior.length === 0) return undefined;

    const window = prior.slice(-6);
    const maxLen = 600;
    const lines: string[] = [];
    for (const msg of window) {
      const role = msg.senderType === "AI" ? "Assistant" : "User";
      const body = (msg.content ?? "").replace(/\s+/g, " ").trim().slice(0, maxLen);
      if (body.length > 0) lines.push(`${role}: ${body}`);
    }
    return lines.length > 0 ? lines.join("\n") : undefined;
  }

  private assembleHistoryFromMessages(
    recent: Message[],
    profile: {
      firstName?: string | null;
      lastName?: string | null;
      role?: string | null;
      userId?: bigint | string | null;
    } | null
  ): AgentInputItem[] {
    const history: AgentInputItem[] = [];
    if (profile) {
      history.push(this.toTechnicianContextItem(profile));
    }

    for (const msg of recent) {
      history.push(...this.toImageSummaryItems(msg));
      history.push(
        msg.senderType === "AI" ? this.toAssistantItem(msg.content) : this.toUserItem(msg.content)
      );
    }

    return history;
  }

  private toImageSummaryItems(message: Message): AgentInputItem[] {
    const summaries = Array.isArray(message.metadata?.imageSummaries)
      ? message.metadata.imageSummaries
      : [];
    return summaries.map((summary) => ({
      role: "assistant",
      type: "message",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: this.formatImageSummary(summary),
        },
      ],
    }));
  }

  private formatImageSummary(summary: any): string {
    const parts: string[] = [];
    parts.push(
      `Image summary (${summary.attachmentId ?? summary.imageFileId ?? summary.image_id ?? "image"}):`
    );
    if (summary.summary) parts.push(summary.summary);
    if (Array.isArray(summary.objects) && summary.objects.length > 0) {
      parts.push(`Objects: ${summary.objects.join(", ")}`);
    }
    if (Array.isArray(summary.observations) && summary.observations.length > 0) {
      parts.push(`Observations: ${summary.observations.join("; ")}`);
    }
    if (summary.inferred_issue) {
      parts.push(`Inferred issue: ${summary.inferred_issue}`);
    }
    if (Array.isArray(summary.linked_entities) && summary.linked_entities.length > 0) {
      parts.push(`Linked entities: ${summary.linked_entities.join(", ")}`);
    }
    return parts.join(" ");
  }

  private toTechnicianContextItem(profile: {
    firstName?: string | null;
    lastName?: string | null;
    role?: string | null;
    userId?: bigint | string | null;
  }): AgentInputItem {
    const text = `
# TECHNICIAN DETAILS
- First Name: ${profile.firstName}
- Last Name: ${profile.lastName}
- Role: ${profile.role}
    `;
    return {
      role: "assistant",
      type: "message",
      status: "completed",
      content: [{ type: "output_text", text }],
    };
  }

  private async getTechnicianProfile(conversationId: string): Promise<{
    firstName?: string | null;
    lastName?: string | null;
    role?: string | null;
    userId?: bigint | string | null;
  } | null> {
    const convo = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        userId: true,
        users: {
          select: {
            first_name: true,
            last_name: true,
            role: true,
          },
        },
      },
    });

    if (!convo) return null;
    return {
      firstName: (convo as any)?.users?.first_name ?? null,
      lastName: (convo as any)?.users?.last_name ?? null,
      role: (convo as any)?.users?.role ?? null,
      userId: convo.userId ?? null,
    };
  }

  private async getJobContext(conversationId: string): Promise<{
    jobNumber?: string;
    issueDescription?: string;
    visitNumber?: number;
    visitDescription?: string;
    jobTargetName?: string;
    address?: string;
    startTimestamp?: string;
    status?: string;
    description?: string;
  } | null> {
    const convo = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        jobs: {
          select: {
            job_target_name: true,
            address: true,
            start_timestamp: true,
            status: true,
            meta_data: true,
            description: true,
          },
        },
      },
    });

    if (!convo?.jobs) return null;

    const meta = (convo.jobs.meta_data as Record<string, unknown>) ?? {};

    return {
      jobTargetName: convo.jobs.job_target_name,
      address: convo.jobs.address,
      startTimestamp: String(convo.jobs.start_timestamp),
      status: convo.jobs.status,
      description: convo.jobs.description ?? undefined,
      jobNumber: (meta.jobNumber as string) ?? undefined,
      issueDescription: (meta.issueDescription as string) ?? convo.jobs.description ?? undefined,
      visitNumber: (meta.visitNumber as number) ?? undefined,
      visitDescription: (meta.description as string) ?? undefined,
    };
  }

  private toJobContextItem(job: {
    jobTargetName?: string;
    address?: string;
    startTimestamp?: string;
    status?: string;
    description?: string;
    jobNumber?: string;
    issueDescription?: string;
    visitNumber?: number;
    visitDescription?: string;
  }): AgentInputItem {
    const text = `
# JOB CONTEXT
- Job Target Name: ${job.jobTargetName ?? "N/A"}
- Address: ${job.address ?? "N/A"}
- Start Timestamp: ${job.startTimestamp ?? "N/A"}
- Status: ${job.status ?? "N/A"}
- Job Number: ${job.jobNumber ?? "N/A"}
- Job Description: ${job.issueDescription ?? job.description ?? "N/A"}
- Visit Number: ${job.visitNumber ?? "N/A"}
- Visit Description: ${job.visitDescription ?? "N/A"}
`;
    return {
      role: "assistant",
      type: "message",
      status: "completed",
      content: [{ type: "output_text", text }],
    };
  }

  private toUserItem(content: string): AgentInputItem {
    return {
      role: "user",
      type: "message",
      content: [{ type: "input_text", text: content }],
    };
  }

  private toAssistantItem(content: string): AgentInputItem {
    return {
      role: "assistant",
      type: "message",
      status: "completed",
      content: [{ type: "output_text", text: content }],
    };
  }

  private static async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private collectToolsUsedFromNewItems(newItems: RunItem[]): string[] {
    const toolsUsed: string[] = [];
    for (const item of newItems) {
      const rawItem = (item as { rawItem?: { type?: string; name?: string } }).rawItem as
        | { type?: string; name?: string }
        | undefined;
      if (rawItem?.type === "hosted_tool_call" || rawItem?.type === "function_call") {
        toolsUsed.push(rawItem.name ?? rawItem.type ?? "tool_call");
      }
    }
    return toolsUsed;
  }

  private static readonly CITATION_RE = /\s*citeturn\d+search\d+/g;
  private static readonly BRACKET_CITE_RE = /\s*【[^】]*】/g;
  /** Longest possible partial match: " citeturn99search99" = ~21 chars; 25 gives headroom. */
  private static readonly CITE_BUFFER_SIZE = 25;
  /** Matches the tail of a string that *could* be the start of a citation token. */
  private static readonly PARTIAL_CITE_RE = /\s*c(?:i(?:t(?:e(?:t(?:u(?:r(?:n(?:\d*(?:s(?:e(?:a(?:r(?:c(?:h(?:\d*)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?$/;

  /**
   * Strip Responses-API auto-citations from a complete (non-streaming) string.
   */
  private static stripCitations(text: string): string {
    return text
      .replace(ClaraAgent.CITATION_RE, "")
      .replace(ClaraAgent.BRACKET_CITE_RE, "")
      .trimEnd();
  }

  /**
   * Creates a stateful filter for streaming deltas that buffers the tail so
   * split citations like "…model. cite" + "turn0search0" are caught.
   * Call `flush()` when the stream ends to emit any held-back safe text.
   */
  private static createCitationFilter() {
    let held = "";
    return {
      push(delta: string): string {
        held += delta;
        held = held
          .replace(ClaraAgent.CITATION_RE, "")
          .replace(ClaraAgent.BRACKET_CITE_RE, "");
        const partialMatch = ClaraAgent.PARTIAL_CITE_RE.exec(held);
        if (partialMatch && partialMatch.index < held.length) {
          const safe = held.slice(0, partialMatch.index);
          held = held.slice(partialMatch.index);
          return safe;
        }
        const safe = held;
        held = "";
        return safe;
      },
      flush(): string {
        const rest = held
          .replace(ClaraAgent.CITATION_RE, "")
          .replace(ClaraAgent.BRACKET_CITE_RE, "")
          .trimEnd();
        held = "";
        return rest;
      },
    };
  }

  private resolveFinalOutputFromStream(stream: { finalOutput?: unknown }, fullText: string): string {
    const fo = stream.finalOutput;
    const raw = typeof fo === "string" && fo.trim().length > 0 ? fo.trim() : fullText.trim();
    return ClaraAgent.stripCitations(raw);
  }

  private isMissingFinalResponseError(error: unknown): boolean {
    if (error instanceof ModelBehaviorError) {
      const msg = String((error as Error).message ?? "");
      return msg.includes("did not produce a final response");
    }
    return false;
  }

  private isAbortError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const e = error as Error;
    if (e.name === "AbortError") return true;
    const msg = String(e.message ?? "");
    return msg.includes("aborted") || msg.includes("The operation was aborted");
  }

  private async consumeStreamedRun(
    stream: AsyncIterable<unknown> & { completed: Promise<void>; finalOutput?: unknown },
    context: AgentContext,
    callbacks?: AgentStreamCallbacks
  ): Promise<{ fullText: string; toolsUsed: string[] }> {
    let fullText = "";
    const toolsUsed: string[] = [];
    const citeFilter = ClaraAgent.createCitationFilter();

    for await (const event of stream) {
      const ev = event as { type?: string };
      if (ev.type === "raw_model_stream_event") {
        const raw = event as RunRawModelStreamEvent;
        const data = raw.data as { delta?: string; text?: string; type?: string };
        const rawDelta = data?.delta ?? data?.text ?? "";
        const isTextDelta = data?.type === "output_text_delta";
        if (isTextDelta && rawDelta) {
          const clean = citeFilter.push(rawDelta);
          if (clean) {
            fullText += clean;
            callbacks?.onTextChunk?.(clean, fullText);
          }
        }
      } else if (ev.type === "run_item_stream_event") {
        const itemEvent = event as RunItemStreamEvent;
        const rawItem: any = itemEvent.item.rawItem;

        if (rawItem?.type === "hosted_tool_call" || rawItem?.type === "function_call") {
          const toolName = rawItem.name ?? rawItem.type ?? "tool_call";
          toolsUsed.push(toolName);
          logger.info(`🔧 TOOL: ${toolName}`, { conversationId: context.conversationId });
          callbacks?.onToolCall?.(toolName);
        }

        if (rawItem?.type === "message" && rawItem?.role === "assistant") {
          const assistantText = Array.isArray(rawItem.content)
            ? rawItem.content
                .filter((c: any) => c?.type === "output_text" && typeof c.text === "string")
                .map((c: any) => c.text)
                .join("")
            : "";
          if (assistantText && !fullText) {
            fullText = ClaraAgent.stripCitations(assistantText);
          }
        }
      }
    }

    const remaining = citeFilter.flush();
    if (remaining) {
      fullText += remaining;
      callbacks?.onTextChunk?.(remaining, fullText);
    }

    await stream.completed;
    return { fullText, toolsUsed };
  }

  private async runAgent(
    agentInstance: Agent<AgentRunContext>,
    messages: AgentInputItem[],
    context: AgentContext,
    callbacks?: AgentStreamCallbacks,
    classificationResult?: ClassificationResult & { classifierTokens?: { prompt: number; completion: number } },
    usage?: { promptTokens?: number }
  ): Promise<AgentResponse> {
    this.lastInteractionTs = Date.now();
    const startTime = Date.now();

    callbacks?.onThinking?.();

    const runContext = {
      conversationId: context.conversationId,
      userId: context.userId,
      timezone: context.timezone,
    };

    let lastError: unknown;

    for (let attempt = 1; attempt <= ClaraAgent.STREAM_MAX_ATTEMPTS; attempt++) {
      const isLastAttempt = attempt === ClaraAgent.STREAM_MAX_ATTEMPTS;
      const useBufferedRun = isLastAttempt;

      try {
        if (context.signal?.aborted) {
          throw new Error("Request aborted");
        }

        if (useBufferedRun) {
          logger.info("ClaraAgent: non-streaming run (final attempt)", {
            conversationId: context.conversationId,
            attempt,
            agent: agentInstance.name,
          });

          const result = await run(agentInstance, messages, {
            stream: false,
            context: runContext,
            signal: context.signal,
          });

          const toolsUsed = this.collectToolsUsedFromNewItems(result.newItems);
          for (const toolName of toolsUsed) {
            callbacks?.onToolCall?.(toolName);
          }

          const fo = result.finalOutput;
          const finalOutput = ClaraAgent.stripCitations(
            typeof fo === "string" && fo.trim().length > 0 ? fo.trim() : ""
          );

          if (finalOutput.length > 0 && callbacks?.onTextChunk) {
            callbacks.onTextChunk(finalOutput, finalOutput);
          }

          if (!finalOutput) {
            throw new Error("Agent produced empty output (buffered run)");
          }

          const durationMs = Date.now() - startTime;
          const uniqueTools = Array.from(new Set(toolsUsed));
          logger.info(`✓ AI (${durationMs}ms): "${finalOutput.slice(0, 180)}${finalOutput.length > 180 ? "…" : ""}"`, {
            conversationId: context.conversationId,
            tools: uniqueTools.length > 0 ? uniqueTools : undefined,
          });

          const response: AgentResponse = {
            messageId: `msg-${Date.now()}`,
            content: finalOutput,
            metadata: {
              model: agentInstance === this.technicalAgent ? DEFAULT_MODEL : FAST_MODEL,
              toolsUsed: uniqueTools,
              durationMs,
              state: classificationResult?.theme,
              classificationConfidence: classificationResult?.confidence,
              classifierTokens: classificationResult?.classifierTokens,
            },
          };

          callbacks?.onComplete?.(response);
          return response;
        }

        const stream = (await run(agentInstance, messages, {
          stream: true,
          context: runContext,
          signal: context.signal,
        })) as AsyncIterable<unknown> & { completed: Promise<void>; finalOutput?: unknown };

        const { fullText, toolsUsed } = await this.consumeStreamedRun(stream, context, callbacks);
        const finalOutput = this.resolveFinalOutputFromStream(stream, fullText);

        if (!finalOutput) {
          logger.warn("ClaraAgent: empty output after stream, will retry", {
            conversationId: context.conversationId,
            attempt,
            agent: agentInstance.name,
            toolsUsedCount: toolsUsed.length,
            fullTextLen: fullText.length,
            streamError: (stream as { error?: unknown }).error,
          });
          lastError = new Error("Agent produced empty output");
          if (context.signal?.aborted) {
            throw lastError;
          }
          await ClaraAgent.sleep(ClaraAgent.STREAM_RETRY_DELAY_MS);
          continue;
        }

        const durationMs = Date.now() - startTime;
        const uniqueTools = Array.from(new Set(toolsUsed));
        logger.info(`✓ AI (${durationMs}ms): "${finalOutput.slice(0, 180)}${finalOutput.length > 180 ? "…" : ""}"`, {
          conversationId: context.conversationId,
          tools: uniqueTools.length > 0 ? uniqueTools : undefined,
        });

        const response: AgentResponse = {
          messageId: `msg-${Date.now()}`,
          content: finalOutput,
          metadata: {
            model: agentInstance === this.technicalAgent ? DEFAULT_MODEL : FAST_MODEL,
            toolsUsed: uniqueTools,
            durationMs,
            state: classificationResult?.theme,
            classificationConfidence: classificationResult?.confidence,
            classifierTokens: classificationResult?.classifierTokens,
          },
        };

        callbacks?.onComplete?.(response);
        return response;
      } catch (error) {
        if (error instanceof InputGuardrailTripwireTriggered) {
          const guardrailOutput = (error as any).result?.output ?? (error as any).output ?? {};
          const guidance =
            guardrailOutput?.outputInfo?.guidance ??
            guardrailOutput?.guidance ??
            "I'm focused on field service (HVAC, plumbing, electrical, fire protection). Please ask about the job or equipment you're working on.";
          return {
            messageId: `guardrail-${Date.now()}`,
            content: guidance,
          };
        }

        if (this.isAbortError(error)) {
          logger.error("ClaraAgent: run aborted", {
            conversationId: context.conversationId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        const canRetry =
          attempt < ClaraAgent.STREAM_MAX_ATTEMPTS &&
          !context.signal?.aborted &&
          (this.isMissingFinalResponseError(error) ||
            (error instanceof Error && error.message === "Agent produced empty output") ||
            (error instanceof Error && error.message === "Agent produced empty output (buffered run)"));

        if (canRetry) {
          logger.warn("ClaraAgent: retrying agent run after stream/model failure", {
            conversationId: context.conversationId,
            attempt,
            agent: agentInstance.name,
            error: error instanceof Error ? error.message : String(error),
            fullTextPreview: this.isMissingFinalResponseError(error) ? "(missing response_done)" : undefined,
          });
          lastError = error;
          await ClaraAgent.sleep(ClaraAgent.STREAM_RETRY_DELAY_MS);
          continue;
        }

        logger.error("ClaraAgent processing error", {
          error,
          conversationId: context.conversationId,
          agent: agentInstance.name,
        });
        throw error;
      }
    }

    logger.error("ClaraAgent: exhausted retries", {
      conversationId: context.conversationId,
      lastError: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Vision-style question using presigned image URLs.
   */
  async processVisionQuestion(
    question: string,
    imageUrls: string[],
    context: AgentContext,
    callbacks?: AgentStreamCallbacks
  ): Promise<AgentResponse> {
    return this.processMessageWithImages(question, imageUrls, context, callbacks);
  }
}

// Singleton instance
let claraInstance: ClaraAgent | null = null;

export async function getClaraAgent(): Promise<ClaraAgent> {
  if (!claraInstance) {
    claraInstance = new ClaraAgent();
    await claraInstance.init();
  }
  return claraInstance;
}

export async function shutdownClaraAgent(): Promise<void> {
  if (claraInstance) {
    await claraInstance.dispose();
    claraInstance = null;
  }
}
