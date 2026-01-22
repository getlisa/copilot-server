import {
  Agent,
  AgentInputItem,
  run,
  RunItemStreamEvent,
  RunRawModelStreamEvent,
  InputGuardrailTripwireTriggered,
} from "@openai/agents";
import {
  setDefaultOpenAIKey,
  webSearchTool,
} from "@openai/agents-openai";
import {
  AIAgent,
  AgentContext,
  AgentResponse,
  AgentStreamCallbacks,
} from "../types/agent.types";
import { messageRepository } from "../api/repositories/message.repository";
import logger from "../lib/logger";
import { systemPrompt } from "../lib/systemPrompt";
import { Message } from "../types/conversation.types";
import { countTokensForMessages } from "../lib/tokenizer";
import prisma from "../lib/prisma";
import { technicalManualTool } from "./tools/RagTool";
import { consumeRagSources } from "./tools/ragToolSources";

type AgentRunContext = {
  conversationId: string;
  userId: string;
  runId: string;
};

type ImageItem = {
  type: "input_image";
  image: string;
};

const DEFAULT_MODEL = process.env.OPENAI_AGENT_MODEL ?? "gpt-4o-mini";
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;
const HISTORY_LIMIT = 15;

export class ClaraAgent implements AIAgent {
  private agent: Agent<AgentRunContext>;
  private lastInteractionTs = Date.now();


  constructor() {
    this.agent = this.buildAgent();
  }

  async init(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required");
    }
    setDefaultOpenAIKey(apiKey);
  }

  private buildAgent(): Agent<AgentRunContext> {
    const tools = [
      technicalManualTool,
    ];

    // if (VECTOR_STORE_ID) {
    //   const vectorStoreIds = VECTOR_STORE_ID.split(",")
    //     .map((id) => id.trim())
    //     .filter(Boolean);
    //   if (vectorStoreIds.length > 0) {
    //     tools.push(fileSearchTool(vectorStoreIds));
    //   }
    // }
    // tools.push(webSearchTool({ searchContextSize: "medium" }));
  
    
    return new Agent<AgentRunContext>({
      name: "Clara - Technician Copilot",
      instructions: systemPrompt,
      model: DEFAULT_MODEL,
      modelSettings:{
        topP: 0.8,
        maxTokens: 800,
        toolChoice: "auto",
        parallelToolCalls: true,
        // promptCacheRetention: "24h",
        // reasoning:{
        //   effort: "medium",
        //   summary: "auto"
        // },
        truncation: "auto",
      },
      tools,
    });
  }

  async processMessage(
    text: string,
    context: AgentContext,
    callbacks?: AgentStreamCallbacks
  ): Promise<AgentResponse> {
    if (!text.trim()) {
      throw new Error("Empty message");
    }

    const history = await this.buildHistory(context.conversationId);

    console.log("History:", JSON.stringify(history, null, 2));

    const messages: AgentInputItem[] = [...history, this.toUserItem(text)] as AgentInputItem[];
    const promptTokens = countTokensForMessages(messages, DEFAULT_MODEL);
    console.log("Prompt tokens:", promptTokens);
    return this.runAgent(messages, context, callbacks);
  }

  /**
   * Accepts inline image data (base64 or data URLs) to avoid external hosting.
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

    // const history = await this.buildHistory(context.conversationId);
    const messages: AgentInputItem[] = [userMessage];
    const promptTokens = countTokensForMessages(messages, DEFAULT_MODEL);

    console.log("Messages SENT###:", JSON.stringify(messages, null, 2) );

    return this.runAgent(messages, context, callbacks, { promptTokens });
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
    logger.debug("ClaraAgent history constructed", {
      conversationId,
      messageCount: recent.length,
      historyItems: history.length,
    });
    console.log("History:", JSON.stringify(history, null, 2));
    return history;
  }

  private toImageSummaryItems(message: Message): AgentInputItem[] {
    const summaries = Array.isArray(message.metadata?.imageSummaries)
      ? message.metadata.imageSummaries
      : [];
    logger.debug("ClaraAgent image summaries", {
      messageId: message.id,
      summaryCount: summaries.length,
    });
    console.log("Summaries:", JSON.stringify(summaries, null, 2));
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
    console.log("Technician context item:", text);

    return {
      role: "assistant",
      type: "message",
      status: "completed",
      content: [
        {
          type: "output_text",
          text,
        },
      ],
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

  private toUserItem(content: string): AgentInputItem {
    return {
      role: "user",
      type: "message",
      content: [
        {
          type: "input_text",
          text: content,
        },
      ],
    };
  }

  private toAssistantItem(content: string): AgentInputItem {
    return {
      role: "assistant",
      type: "message",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: content,
        },
      ],
    };
  }

  private toUserItemWithImages(content: string, images: string[]): AgentInputItem[] {
    const imageItems: ImageItem[] = images.map((img: string) => {
      console.log("Image URL:", img);
      return {
        type: "input_image",
        image: img
      }
    })
    let messages: AgentInputItem[] = [{
      role: "user",
      content: [
        { type: "input_text", text: content },
        ...imageItems,
      ],
    } as AgentInputItem]

    console.log("Messages SENT###:", JSON.stringify(messages, null, 2) );

    return messages;
  }

  private async runAgent(
    messages: AgentInputItem[],
    context: AgentContext,
    callbacks?: AgentStreamCallbacks,
    usage?: { promptTokens?: number }
  ): Promise<AgentResponse> {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const latestUser = [...messages].reverse().find((m: any) => m?.role === "user");
    const latestUserText =
      Array.isArray((latestUser as any)?.content)
        ? (latestUser as any).content
            .filter((c: any) => c?.type === "input_text" && typeof c.text === "string")
            .map((c: any) => c.text)
            .join(" ")
        : typeof (latestUser as any)?.content === "string"
          ? (latestUser as any).content
          : undefined;

    logger.info("Agent run started", {
      runId,
      conversationId: context.conversationId,
      userId: context.userId,
      promptTokens: usage?.promptTokens,
      messageCount: messages.length,
      latestUserText,
    });
    this.lastInteractionTs = Date.now();
    const startTime = Date.now();

    callbacks?.onThinking?.();

    try {
      const stream = await run(
        this.agent,
        messages,
        {
        stream: true,
        context: { conversationId: context.conversationId, userId: context.userId, runId },
      });
      console.log("I am here 00");
      let fullText = "";
      const toolsUsed: string[] = [];
      const toolCalls: Array<{ name: string; callId?: string }> = [];

      for await (const event of stream) {
        if (event.type === "raw_model_stream_event") {
          logger.debug("Agent stream event", {
            runId,
            type: event.type,
            dataType: (event as any)?.data?.type,
          });
        }

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

          // Log every agent item event with its name and key details
          logger.info("Agent run item event", {
            runId,
            name: itemEvent.name,
            itemType: rawItem?.type,
          });

          if (rawItem?.type === "hosted_tool_call" || rawItem?.type === "function_call") {
            const toolName = rawItem.name ?? rawItem.type ?? "tool_call";
            toolsUsed.push(toolName);
            toolCalls.push({ name: toolName, callId: rawItem?.id });
            const argsStr =
              typeof rawItem?.arguments === "string"
                ? rawItem.arguments.slice(0, 500)
                : JSON.stringify(rawItem?.arguments ?? "").slice(0, 500);
            logger.info("Agent tool call", {
              runId,
              toolName,
              callId: rawItem?.id,
              argumentsPreview: argsStr,
            });
            callbacks?.onToolCall?.(toolName);
          }

          // Capture tool outputs when emitted
          if (itemEvent.name === "tool_output") {
            const outputPreview =
              typeof rawItem?.output === "string"
                ? rawItem.output
                : JSON.stringify(rawItem?.output ?? "");
            logger.info("Agent tool output", {
              runId,
              callId: rawItem?.id,
              outputPreview,
            });
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
      console.log("fullText:", fullText);
      const finalOutput =
        typeof stream.finalOutput === "string" && stream.finalOutput.length > 0
          ? stream.finalOutput
          : fullText;
      const finalOutputResolved = finalOutput;
      const sources = consumeRagSources(runId);
      const diagrams = sources.flatMap((source) => source.diagrams ?? []);
      const references = sources
        .map((source) => source.fileUrl)
        .filter((url): url is string => Boolean(url));

      const uniqueDiagrams = Array.from(new Set(diagrams));
      const uniqueReferences = Array.from(new Set(references));

      const buildImageLinks = (urls: string[]) =>
        urls.map((url) => {
          const filename = url.split("?")[0]?.split("/").pop() ?? "Diagram";
          const title = filename.replace(/[-_]+/g, " ").replace(/\.[^/.]+$/, "").trim() || "Diagram";
          return `![${title}](${url})`;
        });
      const buildLinks = (urls: string[]) =>
        urls.map((url) => {
          const filename = url.split("?")[0]?.split("/").pop() ?? "Source";
          const title = filename.replace(/[-_]+/g, " ").replace(/\.[^/.]+$/, "").trim() || "Source";
          return `[${title}](${url})`;
        });

      let finalOutputWithMedia = finalOutputResolved;
      if (uniqueDiagrams.length > 0 && !uniqueDiagrams.some((u) => finalOutputWithMedia.includes(u))) {
        finalOutputWithMedia += `\n\nDiagrams:\n${buildImageLinks(uniqueDiagrams)
          .map((link) => `- ${link}`)
          .join("\n")}`;
      }
      if (uniqueReferences.length > 0 && !uniqueReferences.some((u) => finalOutputWithMedia.includes(u))) {
        finalOutputWithMedia += `\n\nReferences:\n${buildLinks(uniqueReferences)
          .map((link) => `- ${link}`)
          .join("\n")}`;
      }
      console.log(`Final output: ${finalOutputResolved}`);

      const response: AgentResponse = {
        messageId: `msg-${Date.now()}`,
        content: finalOutputWithMedia,
        metadata: {
          model: DEFAULT_MODEL,
          toolsUsed: Array.from(new Set(toolsUsed)),
          durationMs: Date.now() - startTime,
          sources: sources.length > 0 ? sources : undefined,
          diagrams: uniqueDiagrams.length > 0 ? uniqueDiagrams : undefined,
          references: uniqueReferences.length > 0 ? uniqueReferences : undefined,
        },
      };

      logger.info("Agent run completed", {
        runId,
        conversationId: context.conversationId,
        userId: context.userId,
        durationMs: response.metadata?.durationMs,
        toolsUsed: response.metadata?.toolsUsed,
        toolCalls,
        finalOutputPreview: finalOutputWithMedia?.slice(0, 200),
      });
      callbacks?.onComplete?.(response);
      return response;
    } catch (error) {
      logger.error("ClaraAgent processing error", {
        runId,
        conversationId: context.conversationId,
        userId: context.userId,
        error,
      });
      if (error instanceof InputGuardrailTripwireTriggered) {
        const guardrailOutput = (error as any).result?.output ?? (error as any).output ?? {};
        const guidance =
          guardrailOutput?.outputInfo?.guidance ??
          guardrailOutput?.guidance ??
          "I’m focused on field service (HVAC, plumbing, electrical, fire protection). Please ask about the job or equipment you’re working on.";
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
   * Run the dedicated image analyzer to produce a concise summary for history.
   */
  /**
   * Vision-style question using presigned image URLs.
   * We pass the image URLs in the user message so the model can fetch them.
   */
  async processVisionQuestion(
    question: string,
    imageUrls: string[],
    context: AgentContext,
    callbacks?: AgentStreamCallbacks
  ): Promise<AgentResponse> {
    // Reuse the image-aware path to ensure image_url is present in the payload
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
 