import {
  Agent,
  AgentInputItem,
  run,
  RunItemStreamEvent,
  RunRawModelStreamEvent,
  InputGuardrailTripwireTriggered,
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
} from "../lib/systemPrompt";
import { Message } from "../types/conversation.types";
import { countTokensForMessages } from "../lib/tokenizer";
import prisma from "../lib/prisma";
import { getJobContextTool } from "./tools/GetJobContextTool";
import { classifyQuery } from "./classifier";
import { find as findTimezone } from "geo-tz";


type AgentRunContext = {
  conversationId: string;
  userId: string;
  timezone?: string;
};

type ImageItem = {
  type: "input_image";
  image: string;
};

const DEFAULT_MODEL = process.env.OPENAI_AGENT_MODEL ?? "gpt-4o-mini";
const FAST_MODEL = process.env.OPENAI_FAST_MODEL ?? "gpt-4o-mini";
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;
const HISTORY_LIMIT = 15;

const OUT_OF_SCOPE_RESPONSE =
  "I'm Clara, your field service AI assistant. I'm specialized in HVAC, plumbing, electrical, and fire protection. Please ask me about your current job or any technical field service topics — I'm happy to help!";

export class ClaraAgent implements AIAgent {
  private greetingAgent: Agent<AgentRunContext>;
  private jobContextAgent: Agent<AgentRunContext>;
  private technicalAgent: Agent<AgentRunContext>;
  private lastInteractionTs = Date.now();

  constructor() {
    const { greeting, jobContext, technical } = this.buildAgents();
    this.greetingAgent = greeting;
    this.jobContextAgent = jobContext;
    this.technicalAgent = technical;
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
        topP: 0.8,
        maxTokens: 500,
        toolChoice: "required",
        truncation: "auto",
      },
      tools: [getJobContextTool],
    });

    const technicalTools: (ReturnType<typeof fileSearchTool> | typeof getJobContextTool)[] = [];
    if (VECTOR_STORE_ID) {
      const vectorStoreIds = VECTOR_STORE_ID.split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (vectorStoreIds.length > 0) {
        technicalTools.push(fileSearchTool(vectorStoreIds));
      }
    }
    technicalTools.push(webSearchTool({ searchContextSize: "medium" }) as any);
    technicalTools.push(getJobContextTool);

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

    return { greeting, jobContext, technical };
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

    // Run classifier and DB history fetch in parallel to minimize latency
    const [classificationResult, history] = await Promise.all([
      classifyQuery(text),
      this.buildHistory(context.conversationId),
    ]);

    const agent = this.selectAgent(classificationResult.theme);
    logger.info(`✦ CLASSIFIED: ${classificationResult.theme} (${Math.round(classificationResult.confidence * 100)}%) → ${agent.name}`, {
      conversationId: context.conversationId,
      reasoning: classificationResult.reasoning,
      classifierMs: `${Date.now() - startTime}ms`,
    });

    callbacks?.onClassification?.(classificationResult);

    // out_of_scope: return static response without calling any LLM agent
    if (classificationResult.theme === "out_of_scope") {
      const response: AgentResponse = {
        messageId: `msg-${Date.now()}`,
        content: OUT_OF_SCOPE_RESPONSE,
        metadata: {
          model: FAST_MODEL,
          toolsUsed: [],
          durationMs: Date.now() - startTime,
          state: "out_of_scope",
          classificationConfidence: classificationResult.confidence,
          classifierTokens: classificationResult.classifierTokens,
        },
      };
      callbacks?.onComplete?.(response);
      return response;
    }

    const messages: AgentInputItem[] = [...history, this.toUserItem(text)] as AgentInputItem[];

    return this.runAgent(agent, messages, context, callbacks, classificationResult);
  }

  private selectAgent(theme: QueryTheme): Agent<AgentRunContext> {
    switch (theme) {
      case "greeting":
        return this.greetingAgent;
      case "job_context":
        return this.jobContextAgent;
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

  private async buildHistory(conversationId: string): Promise<AgentInputItem[]> {
    const [recent, profile] = await Promise.all([
      messageRepository.getLastMessages(conversationId, HISTORY_LIMIT),
      this.getTechnicianProfile(conversationId),
    ]);

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

    try {
      const stream = await run(agentInstance, messages, {
        stream: true,
        context: { conversationId: context.conversationId, userId: context.userId, timezone: context.timezone },
      });

      let fullText = "";
      const toolsUsed: string[] = [];

      for await (const event of stream) {
        if (event.type === "raw_model_stream_event") {
          const raw = event as RunRawModelStreamEvent;
          const delta = (raw.data as any)?.delta ?? (raw.data as any)?.text ?? "";
          const isTextDelta = (raw.data as any)?.type === "output_text_delta";
          if (isTextDelta && delta) {
            fullText += delta;
            callbacks?.onTextChunk?.(delta, fullText);
          }
        } else if (event.type === "run_item_stream_event") {
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
              fullText = assistantText;
            }
          }
        }
      }

      await stream.completed;

      const finalOutput =
        typeof stream.finalOutput === "string" && stream.finalOutput.length > 0
          ? stream.finalOutput
          : fullText;

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

      logger.error("ClaraAgent processing error", { error });
      callbacks?.onError?.(error as Error);
      throw error;
    }
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
