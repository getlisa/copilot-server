import { Prisma } from "@prisma/client";

type JsonValue = any;
import prisma from "../../lib/prisma";
import {
  Message,
  MessageWithToolCalls,
  CreateMessageInput,
  UpdateMessageInput,
  MessageFilters,
  PaginationParams,
  PaginatedResult,
  ToolCall,
  CreateToolCallInput,
  UpdateToolCallInput,
} from "../../types/conversation.types";

export class MessageRepository {
  /**
   * Create a new message
   */
  async create(data: CreateMessageInput): Promise<Message> {
    console.log(`I'm here 1`)
    return prisma.message.create({
      data: {
        ...(data.id && { id: data.id }),
        conversationId: data.conversationId,
        senderType: data.senderType,
        senderId:
          data.senderId === null || data.senderId === undefined
            ? null
            : typeof data.senderId === "bigint"
            ? data.senderId
            : BigInt(data.senderId),
        content: data.content,
        contentType: data.contentType ?? "TEXT",
        attachments: (data.attachments ?? []) as unknown as JsonValue,
        metadata: (data.metadata ?? {}) as JsonValue,
      },
    }) as unknown as Message;
  }

  /**
   * Create a message and update conversation's updatedAt
   */
  async createWithConversationUpdate(data: CreateMessageInput): Promise<Message> {
    const [message] = await prisma.$transaction([
      prisma.message.create({
        data: {
          ...(data.id && { id: data.id }),
          conversationId: data.conversationId,
          senderType: data.senderType,
          senderId:
            data.senderId === null || data.senderId === undefined
              ? null
              : typeof data.senderId === "bigint"
              ? data.senderId
              : BigInt(data.senderId),
          content: data.content,
          contentType: data.contentType ?? "TEXT",
          attachments: (data.attachments ?? []) as unknown as JsonValue,
          metadata: (data.metadata ?? {}) as JsonValue,
        },
      }),
      prisma.conversation.update({
        where: { id: data.conversationId },
        data: { updatedAt: new Date() },
      }),
    ]);

    return message as unknown as Message;
  }

  /**
   * Get message by ID
   */
  async getById(id: string): Promise<Message | null> {
    return prisma.message.findUnique({
      where: { id },
    }) as unknown as Message | null;
  }

  /**
   * Get message by ID with tool calls
   */
  async getByIdWithToolCalls(id: string): Promise<MessageWithToolCalls | null> {
    return prisma.message.findUnique({
      where: { id },
      include: {
        toolCalls: {
          orderBy: { startedAt: "asc" },
        },
      },
    }) as unknown as MessageWithToolCalls | null;
  }

  /**
   * Update a message
   */
  async update(id: string, data: UpdateMessageInput): Promise<Message> {
    const updateData: Record<string, unknown> = {};

    if (data.content !== undefined) {
      updateData.content = data.content;
      updateData.status = "EDITED";
    }
    if (data.status !== undefined) {
      updateData.status = data.status;
    }
    if (data.metadata !== undefined) {
        updateData.metadata = data.metadata as JsonValue;
    }

    return prisma.message.update({
      where: { id },
      data: updateData,
    }) as unknown as Message;
  }

  /**
   * Soft delete a message (mark as deleted)
   */
  async softDelete(id: string): Promise<Message> {
    return this.update(id, { status: "DELETED" });
  }

  /**
   * Hard delete a message
   */
  async hardDelete(id: string): Promise<void> {
    await prisma.message.delete({
      where: { id },
    });
  }

  /**
   * List messages for a conversation with pagination
   */
  async listByConversation(
    conversationId: string,
    pagination: PaginationParams = {}
  ): Promise<PaginatedResult<Message>> {
    const { cursor, limit = 50, orderBy = "asc" } = pagination;

    const where = {
      conversationId,
      status: { not: "DELETED" as any },
    };

    const [items, total] = await Promise.all([
      prisma.message.findMany({
        where,
        take: limit + 1,
        ...(cursor && {
          skip: 1,
          cursor: { id: cursor },
        }),
        orderBy: { createdAt: orderBy },
        include: {
          toolCalls: true,
        },
      }),
      prisma.message.count({ where }),
    ]);

    const hasMore = items.length > limit;
    if (hasMore) items.pop();

    return {
      items: items as unknown as Message[],
      nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      hasMore,
      total,
    };
  }

  /**
   * Get messages with filters
   */
  async list(
    filters: MessageFilters,
    pagination: PaginationParams = {}
  ): Promise<PaginatedResult<Message>> {
    const { cursor, limit = 50, orderBy = "asc" } = pagination;

    const where = {
      conversationId: filters.conversationId,
      ...(filters.senderType && { senderType: filters.senderType }),
      ...(filters.senderId !== undefined &&
        filters.senderId !== null && {
          senderId: typeof filters.senderId === "bigint" ? filters.senderId : BigInt(filters.senderId),
        }),
      ...(filters.contentType && { contentType: filters.contentType }),
      ...(filters.status && { status: filters.status }),
      ...(filters.createdAfter || filters.createdBefore
        ? {
            createdAt: {
              ...(filters.createdAfter && { gte: filters.createdAfter }),
              ...(filters.createdBefore && { lte: filters.createdBefore }),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.message.findMany({
        where,
        take: limit + 1,
        ...(cursor && {
          skip: 1,
          cursor: { id: cursor },
        }),
        orderBy: { createdAt: orderBy },
      }),
      prisma.message.count({ where }),
    ]);

    const hasMore = items.length > limit;
    if (hasMore) items.pop();

    return {
      items: items as unknown as Message[],
      nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      hasMore,
      total,
    };
  }

  /**
   * Get the last N messages in a conversation
   */
  async getLastMessages(
    conversationId: string,
    count: number = 10
  ): Promise<Message[]> {
    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        status: { not: "DELETED" },
      },
      orderBy: { createdAt: "desc" },
      take: count,
    });

    // Return in chronological order
    return messages.reverse() as unknown as Message[];
  }

  /**
   * Mark message as delivered
   */
  async markDelivered(id: string): Promise<Message> {
    return this.update(id, { status: "DELIVERED" });
  }

  /**
   * Mark message as read
   */
  async markRead(id: string): Promise<Message> {
    return this.update(id, { status: "READ" });
  }

  /**
   * Mark message as failed
   */
  async markFailed(id: string): Promise<Message> {
    return this.update(id, { status: "FAILED" });
  }

  // ============================================
  // TOOL CALL METHODS
  // ============================================

  /**
   * Create a tool call record
   */
  async createToolCall(data: CreateToolCallInput): Promise<ToolCall> {
    return prisma.toolCall.create({
      data: {
        messageId: data.messageId,
        toolName: data.toolName,
        toolInput: data.toolInput as JsonValue,
      },
    }) as unknown as ToolCall;
  }

  /**
   * Update a tool call
   */
  async updateToolCall(id: string, data: UpdateToolCallInput): Promise<ToolCall> {
    const updateData: Record<string, unknown> = {};

    if (data.toolOutput !== undefined) {
      updateData.toolOutput = data.toolOutput as JsonValue;
    }
    if (data.status !== undefined) {
      updateData.status = data.status;
      if (data.status === "COMPLETED" || data.status === "FAILED") {
        updateData.completedAt = new Date();
        // Calculate duration if we have a startedAt
        const toolCall = await prisma.toolCall.findUnique({ where: { id } });
        if (toolCall) {
          updateData.durationMs = Date.now() - toolCall.startedAt.getTime();
        }
      }
    }
    if (data.error !== undefined) {
      updateData.error = data.error;
    }

    return prisma.toolCall.update({
      where: { id },
      data: updateData,
    }) as unknown as ToolCall;
  }

  /**
   * Mark tool call as running
   */
  async markToolCallRunning(id: string): Promise<ToolCall> {
    return this.updateToolCall(id, { status: "RUNNING" });
  }

  /**
   * Complete a tool call
   */
  async completeToolCall(
    id: string,
    output: Record<string, unknown>
  ): Promise<ToolCall> {
    return this.updateToolCall(id, {
      status: "COMPLETED",
      toolOutput: output,
    });
  }

  /**
   * Fail a tool call
   */
  async failToolCall(id: string, error: string): Promise<ToolCall> {
    return this.updateToolCall(id, {
      status: "FAILED",
      error,
    });
  }

  /**
   * Get tool calls for a message
   */
  async getToolCalls(messageId: string): Promise<ToolCall[]> {
    return prisma.toolCall.findMany({
      where: { messageId },
      orderBy: { startedAt: "asc" },
    }) as unknown as ToolCall[];
  }

  /**
   * Get tool call statistics for a conversation
   */
  async getToolCallStats(conversationId: string): Promise<{
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    averageDurationMs: number;
    toolUsage: Record<string, number>;
  }> {
    const messages = await prisma.message.findMany({
      where: { conversationId },
      select: { id: true },
    });
    const messageIds = messages.map((m: { id: string }) => m.id);

    const toolCalls = await prisma.toolCall.findMany({
      where: { messageId: { in: messageIds } },
    });

    const successfulCalls = toolCalls.filter(
      (tc: { status: string }) => tc.status === "COMPLETED"
    );
    const failedCalls = toolCalls.filter(
      (tc: { status: string }) => tc.status === "FAILED"
    );

    const durations = toolCalls
      .filter((tc: { durationMs: number | null }) => tc.durationMs !== null)
      .map((tc: { durationMs: number | null }) => tc.durationMs as number);

    const averageDurationMs =
      durations.length > 0
        ? durations.reduce((a: number, b: number) => a + b, 0) / durations.length
        : 0;

    const toolUsage = toolCalls.reduce(
      (acc: any, tc: any) => {
        acc[tc.toolName] = (acc[tc.toolName] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    return {
      totalCalls: toolCalls.length,
      successfulCalls: successfulCalls.length,
      failedCalls: failedCalls.length,
      averageDurationMs,
      toolUsage,
    };
  }
}

export const messageRepository = new MessageRepository();

