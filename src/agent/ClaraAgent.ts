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
} from "../types/agent.types";
import { messageRepository } from "../api/repositories/message.repository";
import logger from "../lib/logger";
import { systemPrompt } from "../config/systemPrompt";
import { fieldServiceQuestionGuardrail } from "./guardrailAgent";
import { getImageTool } from "../tools/getImageTool";
import { imageAnalyzerAgent } from "./imageAnalyzer";

type AgentRunContext = {
  conversationId: string;
  userId: string;
};

// type InlineImageInput = {
//   data: string;
//   mimeType?: string;
// };

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
    const tools = [webSearchTool({ searchContextSize: "medium" }), getImageTool];

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
      // inputGuardrails: [fieldServiceQuestionGuardrail],
      handoffs: [imageAnalyzerAgent],
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
    const messages: AgentInputItem[] = [...history, this.toUserItem(text)] as AgentInputItem[];
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

    console.log("Messages SENT###:", JSON.stringify(messages, null, 2) );

    return this.runAgent(messages, context, callbacks);
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

  private toUserItemWithImages(content: string, images: string[]): AgentInputItem[] {
    // const imageContents = images.map((img) => {
    //   const hasDataPrefix = img.data.startsWith("data:");
    //   const imageUrl = hasDataPrefix
    //     ? img.data
    //     : `data:${img.mimeType ?? "image/png"};base64,${img.data}`;
    //   return {
    //     type: "input_image",
    //     image_url: imageUrl,
    //   } as const;
    // });

    // return {
    //   role: "user",
    //   type: "message",
    //   content: [
    //     {
    //       type: "input_text",
    //       text: content,
    //     },
    //     ...imageContents,
    //   ],
    // };
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
    callbacks?: AgentStreamCallbacks
  ): Promise<AgentResponse> {
    this.lastInteractionTs = Date.now();
    const startTime = Date.now();

    callbacks?.onThinking?.();

    try {
      const stream = await run(
        this.agent,
        messages,
        {
        stream: true,
        context: { conversationId: context.conversationId, userId: context.userId },
      });
      let fullText = "";
      const toolsUsed: string[] = [];

      for await (const event of stream) {
        console.log(`Event received:`, JSON.stringify(event, null, 2))
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
      console.log(`Final output: ${finalOutput}`);

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
 