import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import {
  ConversationContext,
  CreateContextInput,
  ContextType,
} from "../../types/conversation.types";

export class ContextRepository {
  /**
   * Create a new context entry
   */
  async create(data: CreateContextInput): Promise<ConversationContext> {
    return prisma.conversationContext.create({
      data: {
        conversationId: data.conversationId,
        contextType: data.contextType,
        content: data.content,
        embedding: data.embedding,
        tokenCount: data.tokenCount,
        metadata: (data.metadata ?? {}) as Prisma.InputJsonValue,
        expiresAt: data.expiresAt,
      },
    }) as unknown as ConversationContext;
  }

  /**
   * Get context by ID
   */
  async getById(id: string): Promise<ConversationContext | null> {
    return prisma.conversationContext.findUnique({
      where: { id },
    }) as unknown as ConversationContext | null;
  }

  /**
   * Get all contexts for a conversation
   */
  async getByConversationId(
    conversationId: string
  ): Promise<ConversationContext[]> {
    return prisma.conversationContext.findMany({
      where: {
        conversationId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: "desc" },
    }) as unknown as ConversationContext[];
  }

  /**
   * Get contexts by type for a conversation
   */
  async getByType(
    conversationId: string,
    contextType: ContextType
  ): Promise<ConversationContext[]> {
    return prisma.conversationContext.findMany({
      where: {
        conversationId,
        contextType,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: "desc" },
    }) as unknown as ConversationContext[];
  }

  /**
   * Get the latest context of a specific type
   */
  async getLatestByType(
    conversationId: string,
    contextType: ContextType
  ): Promise<ConversationContext | null> {
    return prisma.conversationContext.findFirst({
      where: {
        conversationId,
        contextType,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: "desc" },
    }) as unknown as ConversationContext | null;
  }

  /**
   * Update context content
   */
  async updateContent(
    id: string,
    content: string,
    tokenCount?: number
  ): Promise<ConversationContext> {
    return prisma.conversationContext.update({
      where: { id },
      data: {
        content,
        ...(tokenCount !== undefined && { tokenCount }),
      },
    }) as unknown as ConversationContext;
  }

  /**
   * Update context embedding
   */
  async updateEmbedding(
    id: string,
    embedding: number[]
  ): Promise<ConversationContext> {
    return prisma.conversationContext.update({
      where: { id },
      data: { embedding },
    }) as unknown as ConversationContext;
  }

  /**
   * Delete a context entry
   */
  async delete(id: string): Promise<void> {
    await prisma.conversationContext.delete({
      where: { id },
    });
  }

  /**
   * Delete all contexts for a conversation
   */
  async deleteByConversationId(conversationId: string): Promise<void> {
    await prisma.conversationContext.deleteMany({
      where: { conversationId },
    });
  }

  /**
   * Delete expired contexts
   */
  async deleteExpired(): Promise<number> {
    const result = await prisma.conversationContext.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
    return result.count;
  }

  /**
   * Upsert a context by type (replace the latest of same type)
   */
  async upsertByType(
    conversationId: string,
    contextType: ContextType,
    content: string,
    options?: {
      embedding?: number[];
      tokenCount?: number;
      metadata?: Record<string, unknown>;
      expiresAt?: Date;
    }
  ): Promise<ConversationContext> {
    // Find existing context of the same type
    const existing = await this.getLatestByType(conversationId, contextType);

    if (existing) {
      // Update existing
      return prisma.conversationContext.update({
        where: { id: existing.id },
        data: {
          content,
          ...(options?.embedding && { embedding: options.embedding }),
          ...(options?.tokenCount !== undefined && {
            tokenCount: options.tokenCount,
          }),
          ...(options?.metadata && {
            metadata: options.metadata as Prisma.InputJsonValue,
          }),
          ...(options?.expiresAt && { expiresAt: options.expiresAt }),
        },
      }) as unknown as ConversationContext;
    } else {
      // Create new
      return this.create({
        conversationId,
        contextType,
        content,
        embedding: options?.embedding,
        tokenCount: options?.tokenCount,
        metadata: options?.metadata,
        expiresAt: options?.expiresAt,
      });
    }
  }

  /**
   * Get total token count for a conversation's contexts
   */
  async getTotalTokenCount(conversationId: string): Promise<number> {
    const result = await prisma.conversationContext.aggregate({
      where: {
        conversationId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      _sum: { tokenCount: true },
    });
    return result._sum.tokenCount ?? 0;
  }

  /**
   * Store a job snapshot context
   */
  async storeJobSnapshot(
    conversationId: string,
    jobData: Record<string, unknown>
  ): Promise<ConversationContext> {
    return this.upsertByType(
      conversationId,
      "JOB_SNAPSHOT",
      JSON.stringify(jobData),
      { metadata: { capturedAt: new Date().toISOString() } }
    );
  }

  /**
   * Store a conversation summary
   */
  async storeSummary(
    conversationId: string,
    summary: string,
    tokenCount?: number
  ): Promise<ConversationContext> {
    return this.upsertByType(conversationId, "SUMMARY", summary, {
      tokenCount,
      metadata: { generatedAt: new Date().toISOString() },
    });
  }

  /**
   * Store a memory chunk
   */
  async storeMemory(
    conversationId: string,
    memory: string,
    options?: {
      embedding?: number[];
      tokenCount?: number;
      expiresAt?: Date;
    }
  ): Promise<ConversationContext> {
    return this.create({
      conversationId,
      contextType: "MEMORY",
      content: memory,
      embedding: options?.embedding,
      tokenCount: options?.tokenCount,
      expiresAt: options?.expiresAt,
    });
  }
}

export const contextRepository = new ContextRepository();

