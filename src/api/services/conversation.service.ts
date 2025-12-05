import {
  conversationRepository,
  messageRepository,
  contextRepository,
} from "../repositories";
import type {
  Conversation,
  ConversationWithMessages,
  Message,
  ConversationFilters,
  PaginationParams,
  PaginatedResult,
  MessageMetadata,
  ChannelType,
  ContentType,
} from "../../types/conversation.types";

export class ConversationService {
  // ============================================
  // CONVERSATION MANAGEMENT
  // ============================================

  /**
   * Start a new conversation for a technician
   */
  async startConversation(
    userId: string,
    options?: {
      jobId?: string;
      channelType?: ChannelType;
      conversationId?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<Conversation> {
    const conversation = await conversationRepository.create({
      userId,
      jobId: options?.jobId,
      channelType: options?.channelType ?? "MESSAGING",
      conversationId: options?.conversationId,
      members: [userId, "copilot_ai"],
      metadata: options?.metadata,
    });

    // Optionally store job snapshot if jobId is provided
    if (options?.jobId && options?.metadata?.jobSnapshot) {
      await contextRepository.storeJobSnapshot(
        conversation.id,
        options.metadata.jobSnapshot as Record<string, unknown>
      );
    }

    return conversation;
  }

  /**
   * Get conversation by ID with messages
   */
  async getConversation(
    conversationId: string,
    includeMessages: boolean = false,
    messageLimit?: number
  ): Promise<Conversation | ConversationWithMessages | null> {
    if (includeMessages) {
      return conversationRepository.getByIdWithMessages(conversationId, messageLimit);
    }
    return conversationRepository.getById(conversationId);
  }

  /**
   * Get or create a conversation for a user and job
   */
  async getOrCreateConversation(
    userId: string,
    jobId: string,
    channelType: ChannelType = "MESSAGING"
  ): Promise<Conversation> {
    // Try to find existing active conversation
    const existing = await conversationRepository.list({
      userId,
      jobId,
      status: "ACTIVE" as any,
    });

    if (existing.items.length > 0) {
      return existing.items[0];
    }

    // Create new conversation
    return this.startConversation(userId, { jobId, channelType });
  }

  /**
   * Get active conversations for a user
   */
  async getActiveConversations(userId: string): Promise<Conversation[]> {
    return conversationRepository.getActiveByUserId(userId);
  }

  /**
   * List conversations with filters
   */
  async listConversations(
    filters: ConversationFilters,
    pagination?: PaginationParams
  ): Promise<PaginatedResult<Conversation>> {
    return conversationRepository.list(filters, pagination);
  }

  /**
   * Close a conversation
   */
  async closeConversation(conversationId: string): Promise<Conversation> {
    return conversationRepository.close(conversationId);
  }

  // ============================================
  // MESSAGE MANAGEMENT
  // ============================================

  /**
   * Send a user message to a conversation
   */
  async sendUserMessage(
    conversationId: string,
    userId: string,
    content: string,
    options?: {
      contentType?: ContentType;
      attachments?: any[];
      metadata?: MessageMetadata;
    }
  ): Promise<Message> {
    return messageRepository.createWithConversationUpdate({
      conversationId,
      senderType: "USER",
      senderId: userId,
      content,
      contentType: options?.contentType ?? "TEXT",
      attachments: options?.attachments,
      metadata: options?.metadata,
    });
  }

  /**
   * Send an AI response to a conversation
   */
  async sendAIMessage(
    conversationId: string,
    content: string,
    metadata?: {
      tokens?: number;
      inferenceTimeMs?: number;
      modelUsed?: string;
      promptTokens?: number;
      completionTokens?: number;
      totalCost?: number;
    }
  ): Promise<Message> {
    return messageRepository.createWithConversationUpdate({
      conversationId,
      senderType: "AI",
      senderId: "copilot_ai",
      content,
      contentType: "TEXT",
      metadata,
    });
  }

  /**
   * Send a system message to a conversation
   */
  async sendSystemMessage(
    conversationId: string,
    content: string
  ): Promise<Message> {
    return messageRepository.createWithConversationUpdate({
      conversationId,
      senderType: "SYSTEM",
      senderId: null,
      content,
      contentType: "TEXT",
    });
  }

  /**
   * Get messages for a conversation
   */
  async getMessages(
    conversationId: string,
    pagination?: PaginationParams
  ): Promise<PaginatedResult<Message>> {
    return messageRepository.listByConversation(conversationId, pagination);
  }

  /**
   * Get the last N messages for context building
   */
  async getLastMessages(
    conversationId: string,
    count: number = 10
  ): Promise<Message[]> {
    return messageRepository.getLastMessages(conversationId, count);
  }

  // ============================================
  // TOOL CALL MANAGEMENT
  // ============================================

  /**
   * Record a tool call invocation
   */
  async recordToolCall(
    messageId: string,
    toolName: string,
    toolInput: Record<string, unknown>
  ) {
    return messageRepository.createToolCall({
      messageId,
      toolName,
      toolInput,
    });
  }

  /**
   * Complete a tool call with output
   */
  async completeToolCall(
    toolCallId: string,
    toolOutput: Record<string, unknown>
  ) {
    return messageRepository.completeToolCall(toolCallId, toolOutput);
  }

  /**
   * Mark a tool call as failed
   */
  async failToolCall(toolCallId: string, error: string) {
    return messageRepository.failToolCall(toolCallId, error);
  }

  // ============================================
  // CONTEXT MANAGEMENT
  // ============================================

  /**
   * Store a conversation summary
   */
  async storeSummary(
    conversationId: string,
    summary: string,
    tokenCount?: number
  ) {
    return contextRepository.storeSummary(conversationId, summary, tokenCount);
  }

  /**
   * Get the latest conversation summary
   */
  async getSummary(conversationId: string) {
    return contextRepository.getLatestByType(
      conversationId,
      "SUMMARY"
    );
  }

  /**
   * Store a memory chunk for RAG
   */
  async storeMemory(
    conversationId: string,
    memory: string,
    options?: {
      embedding?: number[];
      tokenCount?: number;
      expiresAt?: Date;
    }
  ) {
    return contextRepository.storeMemory(conversationId, memory, options);
  }

  /**
   * Get all contexts for a conversation
   */
  async getContexts(conversationId: string) {
    return contextRepository.getByConversationId(conversationId);
  }

  // ============================================
  // ANALYTICS & REPORTING
  // ============================================

  /**
   * Get comprehensive conversation analytics
   */
  async getConversationAnalytics(conversationId: string) {
    const [stats, toolCallStats] = await Promise.all([
      conversationRepository.getStats(conversationId),
      messageRepository.getToolCallStats(conversationId),
    ]);

    return {
      conversation: stats,
      toolCalls: toolCallStats,
    };
  }

  /**
   * Build context for LLM prompt
   */
  async buildLLMContext(
    conversationId: string,
    options?: {
      maxMessages?: number;
      includeSummary?: boolean;
      includeJobSnapshot?: boolean;
    }
  ): Promise<{
    messages: { role: string; content: string }[];
    summary?: string;
    jobSnapshot?: Record<string, unknown>;
  }> {
    const maxMessages = options?.maxMessages ?? 20;

    const [messages, summary, jobSnapshot] = await Promise.all([
      this.getLastMessages(conversationId, maxMessages),
      options?.includeSummary !== false
        ? this.getSummary(conversationId)
        : null,
      options?.includeJobSnapshot !== false
        ? contextRepository.getLatestByType(conversationId, "JOB_SNAPSHOT")
        : null,
    ]);

    // Format messages for LLM
    const formattedMessages = messages.map((msg: Message) => ({
      role:
        msg.senderType === "USER"
          ? "user"
          : msg.senderType === "AI"
          ? "assistant"
          : "system",
      content: msg.content,
    }));

    return {
      messages: formattedMessages,
      summary: summary?.content,
      jobSnapshot: jobSnapshot ? JSON.parse(jobSnapshot.content) : undefined,
    };
  }
}

export const conversationService = new ConversationService();

