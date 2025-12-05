import {
  Agent,
  AgentInputItem,
  run,
  RunItemStreamEvent,
  RunRawModelStreamEvent,
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
} from "../types/agent.types";
import { messageRepository } from "../api/repositories/message.repository";
import logger from "../lib/logger";
import { systemPrompt } from "../config/systemPrompt";

type AgentRunContext = {
  conversationId: string;
  userId: string;
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
    const tools = [webSearchTool({ searchContextSize: "medium" })];

    if (VECTOR_STORE_ID) {
      const vectorStoreIds = VECTOR_STORE_ID.split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (vectorStoreIds.length > 0) {
        tools.push(fileSearchTool(vectorStoreIds));
      }
    }

    return new Agent<AgentRunContext>({
      name: "Clara - Technician Copilot",
      instructions: systemPrompt,
      model: DEFAULT_MODEL,
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

    this.lastInteractionTs = Date.now();
    const startTime = Date.now();

    const history = await this.buildHistory(context.conversationId);
    const input: AgentInputItem[] = [...history, this.toUserItem(text)];

    callbacks?.onThinking?.();

    try {
      const stream = await run(this.agent, input, {
        stream: true,
        context: { conversationId: context.conversationId, userId: context.userId },
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

      const response: AgentResponse = {
        messageId: `msg-${Date.now()}`,
        content: finalOutput,
        metadata: {
          model: DEFAULT_MODEL,
          toolsUsed: Array.from(new Set(toolsUsed)),
          durationMs: Date.now() - startTime,
        },
      };

      callbacks?.onComplete?.(response);
      return response;
    } catch (error) {
      logger.error("ClaraAgent processing error", { error });
      callbacks?.onError?.(error as Error);
      throw error;
    }
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
    const recent = await messageRepository.getLastMessages(conversationId, HISTORY_LIMIT);
    return recent.map((msg) =>
      msg.senderType === "AI" ? this.toAssistantItem(msg.content) : this.toUserItem(msg.content)
    );
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
 