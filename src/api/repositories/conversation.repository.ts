import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import {
  Conversation,
  ConversationWithMessages,
  CreateConversationInput,
  UpdateConversationInput,
  ConversationFilters,
  PaginationParams,
  PaginatedResult,
} from "../../types/conversation.types";

export class ConversationRepository {
  /**
   * Create a new conversation
   */
  async create(data: CreateConversationInput): Promise<Conversation> {
    const members = data.members ?? [data.userId, "clara"];
    return prisma.conversation.create({
      data: {
        userId: data.userId,
        jobId: data.jobId ?? null,
        channelType: data.channelType,
        ...(data.conversationId !== undefined && { conversationId: data.conversationId }),
        members,
        metadata: (data.metadata ?? {}) as Prisma.InputJsonValue,
      },
    }) as unknown as Conversation;
  }

  /**
   * Get conversation by ID
   */
  async getById(id: string): Promise<Conversation | null> {
    return prisma.conversation.findUnique({
      where: { id },
    }) as unknown as Conversation | null;
  }

  /**
   * Get conversation by ID with all messages
   */
  async getByIdWithMessages(
    id: string,
    messageLimit?: number
  ): Promise<ConversationWithMessages | null> {
    return prisma.conversation.findUnique({
      where: { id },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          take: messageLimit,
          include: {
            toolCalls: true,
          },
        },
      },
    }) as unknown as ConversationWithMessages | null;
  }

  /**
   * Get conversation by job ID (unique - one conversation per job)
   */
  async getByJobIdUnique(jobId: string): Promise<Conversation | null> {
    return prisma.conversation.findUnique({
      where: { jobId },
    }) as unknown as Conversation | null;
  }

  /**
   * Get or create a conversation for a job
   * Returns existing conversation if one exists for the job, otherwise creates new
   */
  async getOrCreateByJobId(data: CreateConversationInput): Promise<{ conversation: Conversation; created: boolean }> {
    if (!data.jobId) {
      // No jobId, always create new
      const conversation = await this.create(data);
      return { conversation, created: true };
    }

    // Check if conversation exists for this job
    const existing = await this.getByJobIdUnique(data.jobId);
    if (existing) {
      return { conversation: existing, created: false };
    }

    // Create new conversation
    const conversation = await this.create(data);
    return { conversation, created: true };
  }

  /**
   * Update conversation
   */
  async update(
    id: string,
    data: UpdateConversationInput
  ): Promise<Conversation> {
    return prisma.conversation.update({
      where: { id },
      data: {
        ...(data.status && { status: data.status }),
        ...(data.members && { members: data.members }),
        ...(data.metadata && { metadata: data.metadata as Prisma.InputJsonValue }),
      },
    }) as unknown as Conversation;
  }

  /**
   * Close a conversation
   */
  async close(id: string): Promise<Conversation> {
    return this.update(id, { status: "CLOSED" });
  }

  /**
   * Archive a conversation
   */
  async archive(id: string): Promise<Conversation> {
    return this.update(id, { status: "ARCHIVED" });
  }

  /**
   * List conversations with filters and pagination
   */
  async list(
    filters: ConversationFilters,
    pagination: PaginationParams = {}
  ): Promise<PaginatedResult<Conversation>> {
    const { cursor, limit = 20, orderBy = "desc" } = pagination;

    const where = {
      ...(filters.userId && { userId: filters.userId }),
      ...(filters.jobId && { jobId: filters.jobId }),
      ...(filters.channelType && { channelType: filters.channelType }),
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
      prisma.conversation.findMany({
        where,
        take: limit + 1, // Get one extra to check if there are more
        ...(cursor && {
          skip: 1,
          cursor: { id: cursor },
        }),
        orderBy: { createdAt: orderBy },
      }),
      prisma.conversation.count({ where }),
    ]);

    const hasMore = items.length > limit;
    if (hasMore) items.pop();

    return {
      items: items as unknown as Conversation[],
      nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      hasMore,
      total,
    };
  }

  /**
   * Get conversations for a user
   */
  async getByUserId(
    userId: string,
    pagination?: PaginationParams
  ): Promise<PaginatedResult<Conversation>> {
    return this.list({ userId }, pagination);
  }

  /**
   * Get conversations for a job
   */
  async getByJobId(
    jobId: string,
    pagination?: PaginationParams
  ): Promise<PaginatedResult<Conversation>> {
    return this.list({ jobId }, pagination);
  }

  /**
   * Get active conversations for a user
   */
  async getActiveByUserId(userId: string): Promise<Conversation[]> {
    return prisma.conversation.findMany({
      where: {
        userId,
        status: "ACTIVE",
      },
      orderBy: { updatedAt: "desc" },
    }) as unknown as Conversation[];
  }

  /**
   * Add a member to conversation
   */
  async addMember(id: string, memberId: string): Promise<Conversation> {
    const conversation = await this.getById(id);
    if (!conversation) throw new Error("Conversation not found");

    const members = [...new Set([...conversation.members, memberId])];
    return this.update(id, { members });
  }

  /**
   * Remove a member from conversation
   */
  async removeMember(id: string, memberId: string): Promise<Conversation> {
    const conversation = await this.getById(id);
    if (!conversation) throw new Error("Conversation not found");

    const members = conversation.members.filter((m) => m !== memberId);
    return this.update(id, { members });
  }

  /**
   * Delete a conversation (soft delete by archiving)
   */
  async softDelete(id: string): Promise<Conversation> {
    return this.archive(id);
  }

  /**
   * Hard delete a conversation (use with caution)
   */
  async hardDelete(id: string): Promise<void> {
    await prisma.conversation.delete({
      where: { id },
    });
  }

  /**
   * Get conversation statistics
   */
  async getStats(conversationId: string): Promise<{
    messageCount: number;
    userMessageCount: number;
    aiMessageCount: number;
    firstMessageAt: Date | null;
    lastMessageAt: Date | null;
  }> {
    const [messageCount, userMessageCount, aiMessageCount, firstMessage, lastMessage] =
      await Promise.all([
        prisma.message.count({ where: { conversationId } }),
        prisma.message.count({
          where: { conversationId, senderType: "USER" },
        }),
        prisma.message.count({
          where: { conversationId, senderType: "AI" },
        }),
        prisma.message.findFirst({
          where: { conversationId },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        }),
        prisma.message.findFirst({
          where: { conversationId },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
      ]);

    return {
      messageCount,
      userMessageCount,
      aiMessageCount,
      firstMessageAt: firstMessage?.createdAt ?? null,
      lastMessageAt: lastMessage?.createdAt ?? null,
    };
  }
}

export const conversationRepository = new ConversationRepository();

