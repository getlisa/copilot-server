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
import { systemPrompt } from "../lib/systemPrompt";
import { Message } from "../types/conversation.types";
import { countTokensForMessages } from "../lib/tokenizer";
import prisma from "../lib/prisma";
import { find as findTimezone } from "geo-tz";

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
    const tools = [];

    if (VECTOR_STORE_ID) {
      const vectorStoreIds = VECTOR_STORE_ID.split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (vectorStoreIds.length > 0) {
        tools.push(fileSearchTool(vectorStoreIds));
      }
    }
    tools.push(webSearchTool({ searchContextSize: "medium" }));

    return new Agent<AgentRunContext>({
      name: "Clara - Technician Copilot",
      instructions: systemPrompt,
      model: DEFAULT_MODEL,
      modelSettings:{
        topP: 0.8,
        maxTokens: 800,
        toolChoice: "required",
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

    const history = await this.buildHistory(context.conversationId, context.timezone);

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

  private async buildHistory(conversationId: string, timezone?: string): Promise<AgentInputItem[]> {
    const [recent, profile, jobContext] = await Promise.all([
      messageRepository.getLastMessages(conversationId, HISTORY_LIMIT),
      this.getTechnicianProfile(conversationId),
      this.getJobContext(conversationId, timezone),
    ]);

    const history: AgentInputItem[] = [];
    if (profile) {
      history.push(this.toTechnicianContextItem(profile));
    }
    if (jobContext) {
      history.push(this.toJobContextItem(jobContext));
    }

    logger.info("ClaraAgent context injected", {
      conversationId,
      technicianProfile: profile ?? "none",
      jobContext: jobContext ?? "none",
    });

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

  private getTimezoneFromCoordinates(lat?: number | null, lng?: number | null): string | undefined {
    if (lat == null || lng == null) return undefined;
    try {
      const [tz] = findTimezone(lat, lng);
      return tz;
    } catch {
      return undefined;
    }
  }

  private normalizeTimezone(timezone?: string): string | undefined {
    if (!timezone) return undefined;
    const trimmed = timezone.trim();
    if (!trimmed) return undefined;
    // Common legacy alias used by some clients.
    if (trimmed === "Asia/Calcutta") return "Asia/Kolkata";
    return trimmed;
  }

  private tryFormatWithTimezone(ts: Date | string, timezone: string): string | undefined {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(ts));
    } catch {
      return undefined;
    }
  }

  private formatTimestamp(
    ts: Date | string,
    options?: { timezone?: string; lat?: number | null; lng?: number | null }
  ): string {
    const dateObj = new Date(ts);
    const utcTime = Number.isNaN(dateObj.getTime()) ? String(ts) : dateObj.toISOString();

    const headerTimezone = this.normalizeTimezone(options?.timezone);
    if (headerTimezone) {
      const formatted = this.tryFormatWithTimezone(ts, headerTimezone);
      if (formatted) {
        logger.info("Timestamp conversion method", {
          source: "device_header",
          timezone: headerTimezone,
          utcTime,
          convertedTime: formatted,
        });
        return formatted;
      }
      logger.warn("Invalid device timezone header; trying geolocation fallback", {
        timezone: headerTimezone,
        utcTime,
      });
    }

    const geoTimezone = this.getTimezoneFromCoordinates(options?.lat, options?.lng);
    if (geoTimezone) {
      const formatted = this.tryFormatWithTimezone(ts, geoTimezone);
      if (formatted) {
        logger.info("Timestamp conversion method", {
          source: "geolocation_fallback",
          timezone: geoTimezone,
          utcTime,
          convertedTime: formatted,
        });
        return formatted;
      }
    }

    logger.info("Timestamp conversion method", {
      source: "raw_utc_fallback",
      timezone: "UTC",
      utcTime,
      convertedTime: String(ts),
    });
    return String(ts);
  }

  private async getJobContext(conversationId: string, timezone?: string): Promise<{
    jobNumber?: string;
    issueDescription?: string;
    visitNumber?: number;
    visitDescription?: string;
    jobTargetName?: string;
    address?: string;
    startTimestamp?: string;
    status?: string;
    companies?: string;
    description?: string;
    previousVisits?: { visitNumber: number; technicianName: string; description?: string; startTimestamp: string; status: string }[];
  } | null> {
    const convo = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        jobs: {
          select: {
            id: true,
            company_id: true,
            job_target_name: true,
            address: true,
            start_timestamp: true,
            status: true,
            companies: true,
            meta_data: true,
            description: true,
            geocoded_lat: true,
            geocoded_lng: true,
          },
        },
      },
    });

    if (!convo?.jobs) return null;

    const meta = (convo.jobs.meta_data as Record<string, unknown>) ?? {};
    const jobNumber = (meta.jobNumber as string) ?? undefined;
    const dbStartTimestamp =
      convo.jobs.start_timestamp instanceof Date
        ? convo.jobs.start_timestamp.toISOString()
        : String(convo.jobs.start_timestamp);

    logger.info("Job context fetched from database", {
      conversationId,
      jobId: String(convo.jobs.id),
      jobNumber: jobNumber ?? "N/A",
      visitNumber: (meta.visitNumber as number) ?? "N/A",
      dbStartTimestamp,
      dbAddress: convo.jobs.address ?? "N/A",
      geocodedLat: convo.jobs.geocoded_lat ?? null,
      geocodedLng: convo.jobs.geocoded_lng ?? null,
    });

    let previousVisits: { visitNumber: number; technicianName: string; description?: string; startTimestamp: string; status: string }[] = [];

    if (jobNumber) {
      const siblingJobs = await prisma.jobs.findMany({
        where: {
          company_id: convo.jobs.company_id,
          meta_data: { path: ["jobNumber"], equals: jobNumber },
          id: { not: convo.jobs.id },
        },
        orderBy: { start_timestamp: "desc" },
        take: 10,
        select: {
          meta_data: true,
          start_timestamp: true,
          status: true,
          description: true,
          geocoded_lat: true,
          geocoded_lng: true,
          users: {
            select: { first_name: true, last_name: true },
          },
        },
      });

      previousVisits = siblingJobs.map((v) => {
        const vMeta = (v.meta_data as Record<string, unknown>) ?? {};
        const techName = v.users
          ? `${v.users.first_name} ${v.users.last_name}`
          : "Unassigned";
        return {
          visitNumber: (vMeta.visitNumber as number) ?? 0,
          technicianName: techName,
          description: (vMeta.description as string) ?? v.description ?? undefined,
          startTimestamp: this.formatTimestamp(v.start_timestamp, {
            timezone,
            lat: v.geocoded_lat,
            lng: v.geocoded_lng,
          }),
          status: v.status,
        };
      });

      previousVisits.sort((a, b) => a.visitNumber - b.visitNumber);
    }

    return {
      jobTargetName: convo.jobs.job_target_name,
      address: convo.jobs.address,
      startTimestamp: this.formatTimestamp(convo.jobs.start_timestamp, {
        timezone,
        lat: convo.jobs.geocoded_lat,
        lng: convo.jobs.geocoded_lng,
      }),
      status: convo.jobs.status,
      description: convo.jobs.description ?? undefined,
      jobNumber,
      issueDescription: (meta.issueDescription as string) ?? convo.jobs.description ?? undefined,
      visitNumber: (meta.visitNumber as number) ?? undefined,
      visitDescription: (meta.description as string) ?? undefined,
      previousVisits: previousVisits.length > 0 ? previousVisits : undefined,
    };
  }

  private toJobContextItem(job: {
    jobTargetName?: string;
    address?: string;
    startTimestamp?: string;
    status?: string;
    companies?: string;
    description?: string;
    jobNumber?: string;
    issueDescription?: string;
    visitNumber?: number;
    visitDescription?: string;
    previousVisits?: { visitNumber: number; technicianName: string; description?: string; startTimestamp: string; status: string }[];
  }): AgentInputItem {
    const visitLines = job.previousVisits?.length
      ? job.previousVisits.map(
          (v) => `  - Visit #${v.visitNumber}: ${v.technicianName} | ${v.startTimestamp} | ${v.status}${v.description ? ` | ${v.description}` : ""}`
        ).join("\n")
      : "  None";

    const text = `
# JOB CONTEXT
- Job Target Name: ${job.jobTargetName ?? "N/A"}
- Address: ${job.address ?? "N/A"}
- Start Timestamp: ${job.startTimestamp ?? "N/A"}
- Status: ${job.status ?? "N/A"}
- Companies: ${job.companies ?? "N/A"}
- Job Number: ${job.jobNumber ?? "N/A"}
- Job Description: ${job.issueDescription ?? job.description ?? "N/A"}
- Current Visit Number: ${job.visitNumber ?? "N/A"}
- Current Visit Description: ${job.visitDescription ?? "N/A"}

## Previous Visits (${job.previousVisits?.length ?? 0})
${visitLines}
`;
    logger.info("ClaraAgent job context shared with copilot", {
      jobNumber: job.jobNumber ?? "N/A",
      currentVisitNumber: job.visitNumber ?? "N/A",
      previousVisitCount: job.previousVisits?.length ?? 0,
      contextText: text,
    });

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
        // console.log("Event received: ", JSON.stringify(event, null, 2));
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
      console.log("fullText:", fullText);
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
 