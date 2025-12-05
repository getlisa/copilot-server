import { z } from "zod";

// ============================================
// ENUMS (Zod versions matching Prisma enums)
// ============================================

export const channelTypeSchema = z.enum(["MESSAGING"]);

export const conversationStatusSchema = z.enum(["ACTIVE", "CLOSED", "ARCHIVED"]);

export const senderTypeSchema = z.enum(["USER", "AI", "SYSTEM"]);

export const contentTypeSchema = z.enum([
  "TEXT",
  "IMAGE",
  "AUDIO",
  "VIDEO",
  "FILE",
  "TOOL_CALL",
  "TOOL_RESULT",
  "ERROR",
]);

export const messageStatusSchema = z.enum([
  "PENDING",
  "SENT",
  "DELIVERED",
  "READ",
  "FAILED",
  "EDITED",
  "DELETED",
]);

export const contextTypeSchema = z.enum([
  "SUMMARY",
  "MEMORY",
  "EMBEDDING",
  "JOB_SNAPSHOT",
  "SYSTEM_PROMPT",
]);

// ============================================
// SHARED SCHEMAS
// ============================================

export const attachmentSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  type: z.string(), // MIME type
  filename: z.string().optional(),
  size: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const paginationSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.number().min(1).max(100).default(20),
  orderBy: z.enum(["asc", "desc"]).default("desc"),
});

// ============================================
// CONVERSATION SCHEMAS
// ============================================

// Create conversation
export const createConversationSchema = z.object({
  body: z.object({
    userId: z.string().min(1, "User ID is required"),
    jobId: z.string().nullable(),
    channelType: channelTypeSchema,
    conversationId: z.string().optional(),
    members: z.array(z.string()).optional(),
    metadata: z
      .object({
        deviceInfo: z
          .object({
            platform: z.string().optional(),
            version: z.string().optional(),
            userAgent: z.string().optional(),
          })
          .optional(),
        location: z
          .object({
            latitude: z.number().optional(),
            longitude: z.number().optional(),
            address: z.string().optional(),
          })
          .optional(),
        jobSnapshot: z
          .object({
            jobType: z.string().optional(),
            customerName: z.string().optional(),
            scheduledAt: z.string().optional(),
            priority: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
  }),
});

// Get conversation by ID
export const getConversationSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("Invalid conversation ID"),
  }),
});

// Get conversation with messages
export const getConversationWithMessagesSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("Invalid conversation ID"),
  }),
  query: z.object({
    messageLimit: z.coerce.number().min(1).max(1000).optional(),
  }),
});

// Update conversation
export const updateConversationSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("Invalid conversation ID"),
  }),
  body: z.object({
    status: conversationStatusSchema.optional(),
    members: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
    conversationId: z.string().optional(),
  }),
});

// List conversations (with filters)
export const listConversationsSchema = z.object({
  query: z.object({
    userId: z.string().optional(),
    jobId: z.string().optional(),
    channelType: channelTypeSchema.optional(),
    status: conversationStatusSchema.optional(),
    createdAfter: z.coerce.date().optional(),
    createdBefore: z.coerce.date().optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().min(1).max(100).default(20),
    orderBy: z.enum(["asc", "desc"]).default("desc"),
  }),
});

// Close conversation
export const closeConversationSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("Invalid conversation ID"),
  }),
});

// Add member to conversation
export const addMemberSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("Invalid conversation ID"),
  }),
  body: z.object({
    memberId: z.string().min(1, "Member ID is required"),
  }),
});

// Remove member from conversation
export const removeMemberSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("Invalid conversation ID"),
    memberId: z.string().min(1, "Member ID is required"),
  }),
});

// ============================================
// MESSAGE SCHEMAS
// ============================================

// Create message
export const createMessageSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("Invalid conversation ID"),
  }),
  body: z.object({
    senderType: senderTypeSchema,
    senderId: z.string().nullable().optional(),
    content: z.string().min(1, "Message content is required"),
    contentType: contentTypeSchema.default("TEXT"),
    attachments: z.array(attachmentSchema).optional(),
    metadata: z
      .object({
        tokens: z.number().optional(),
        inferenceTimeMs: z.number().optional(),
        modelUsed: z.string().optional(),
        promptTokens: z.number().optional(),
        completionTokens: z.number().optional(),
        totalCost: z.number().optional(),
        temperature: z.number().optional(),
      })
      .passthrough()
      .optional(),
  }),
});

// Get message by ID
export const getMessageSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("Invalid conversation ID"),
    messageId: z.string().uuid("Invalid message ID"),
  }),
});

// Update message
export const updateMessageSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("Invalid conversation ID"),
    messageId: z.string().uuid("Invalid message ID"),
  }),
  body: z.object({
    content: z.string().min(1).optional(),
    status: messageStatusSchema.optional(),
    metadata: z.record(z.unknown()).optional(),
  }),
});

// List messages for a conversation
export const listMessagesSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("Invalid conversation ID"),
  }),
  query: z.object({
    senderType: senderTypeSchema.optional(),
    senderId: z.string().optional(),
    contentType: contentTypeSchema.optional(),
    status: messageStatusSchema.optional(),
    createdAfter: z.coerce.date().optional(),
    createdBefore: z.coerce.date().optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().min(1).max(100).default(50),
    orderBy: z.enum(["asc", "desc"]).default("asc"),
  }),
});

// Delete message
export const deleteMessageSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("Invalid conversation ID"),
    messageId: z.string().uuid("Invalid message ID"),
  }),
});

// ============================================
// TOOL CALL SCHEMAS
// ============================================

// Create tool call
export const createToolCallSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("Invalid conversation ID"),
    messageId: z.string().uuid("Invalid message ID"),
  }),
  body: z.object({
    toolName: z.string().min(1, "Tool name is required"),
    toolInput: z.record(z.unknown()),
  }),
});

// Complete tool call
export const completeToolCallSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("Invalid conversation ID"),
    messageId: z.string().uuid("Invalid message ID"),
    toolCallId: z.string().uuid("Invalid tool call ID"),
  }),
  body: z.object({
    toolOutput: z.record(z.unknown()).optional(),
    error: z.string().optional(),
  }),
});

// ============================================
// CONTEXT SCHEMAS
// ============================================

// Create context
export const createContextSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("Invalid conversation ID"),
  }),
  body: z.object({
    contextType: contextTypeSchema,
    content: z.string().min(1, "Context content is required"),
    embedding: z.array(z.number()).optional(),
    tokenCount: z.number().optional(),
    metadata: z.record(z.unknown()).optional(),
    expiresAt: z.coerce.date().optional(),
  }),
});

// Get contexts for a conversation
export const getContextsSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("Invalid conversation ID"),
  }),
  query: z.object({
    contextType: contextTypeSchema.optional(),
  }),
});

// ============================================
// ANALYTICS SCHEMAS
// ============================================

// Get conversation stats
export const getConversationStatsSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("Invalid conversation ID"),
  }),
});

// Type exports for use in controllers
export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type GetConversationInput = z.infer<typeof getConversationSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
export type ListConversationsInput = z.infer<typeof listConversationsSchema>;
export type CreateMessageInput = z.infer<typeof createMessageSchema>;
export type GetMessageInput = z.infer<typeof getMessageSchema>;
export type UpdateMessageInput = z.infer<typeof updateMessageSchema>;
export type ListMessagesInput = z.infer<typeof listMessagesSchema>;
export type CreateToolCallInput = z.infer<typeof createToolCallSchema>;
export type CompleteToolCallInput = z.infer<typeof completeToolCallSchema>;
export type CreateContextInput = z.infer<typeof createContextSchema>;
export type GetContextsInput = z.infer<typeof getContextsSchema>;

