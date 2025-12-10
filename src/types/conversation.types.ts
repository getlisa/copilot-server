// ============================================
// STRING LITERAL TYPES (compatible with Zod)
// ============================================

export type ChannelType = "MESSAGING";

export type ConversationStatus = "ACTIVE" | "CLOSED" | "ARCHIVED";

export type SenderType = "USER" | "AI" | "SYSTEM";

export type ContentType =
  | "TEXT"
  | "IMAGE"
  | "AUDIO"
  | "VIDEO"
  | "FILE"
  | "TOOL_CALL"
  | "TOOL_RESULT"
  | "ERROR";

export type MessageStatus =
  | "PENDING"
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "FAILED"
  | "EDITED"
  | "DELETED";

export type ToolCallStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";

export type ContextType =
  | "SUMMARY"
  | "MEMORY"
  | "EMBEDDING"
  | "JOB_SNAPSHOT"
  | "SYSTEM_PROMPT";

// ============================================
// METADATA INTERFACES
// ============================================

export interface ConversationMetadata {
  deviceInfo?: {
    platform?: string;
    version?: string;
    userAgent?: string;
  };
  location?: {
    latitude?: number;
    longitude?: number;
    address?: string;
  };
  jobSnapshot?: {
    jobType?: string;
    customerName?: string;
    scheduledAt?: string;
    priority?: string;
  };
  [key: string]: unknown;
}

export interface MessageMetadata {
  tokens?: number;
  inferenceTimeMs?: number;
  modelUsed?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalCost?: number;
  temperature?: number;
  [key: string]: unknown;
}

export interface Attachment {
  id: string;
  url: string;
  type: string;
  filename?: string;
  size?: number;
  metadata?: Record<string, unknown>;
}

// ============================================
// CORE DOMAIN INTERFACES
// ============================================

export interface Conversation {
  id: string;
  userId: bigint | string | null;
  jobId: bigint | string;
  channelType: ChannelType;
  conversationId: string | null;
  members: string[];
  status: ConversationStatus;
  metadata: ConversationMetadata;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationWithMessages extends Conversation {
  messages: Message[];
}

export interface ConversationWithContext extends Conversation {
  context: ConversationContext[];
}

export interface Message {
  id: string;
  conversationId: string;
  senderType: SenderType;
  senderId: bigint | string | null;
  content: string;
  contentType: ContentType;
  attachments: Attachment[];
  metadata: MessageMetadata;
  status: MessageStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageWithToolCalls extends Message {
  toolCalls: ToolCall[];
}

export interface ToolCall {
  id: string;
  messageId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: Record<string, unknown> | null;
  status: ToolCallStatus;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  error: string | null;
}

export interface ConversationContext {
  id: string;
  conversationId: string;
  contextType: ContextType;
  content: string;
  embedding: number[] | null;
  tokenCount: number | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
}

// ============================================
// INPUT TYPES (for creating/updating)
// ============================================

export interface CreateConversationInput {
  userId: string | bigint | null;
  jobId: string | bigint;
  channelType: ChannelType;
  conversationId?: string | null;
  members?: string[];
  metadata?: ConversationMetadata;
}

export interface UpdateConversationInput {
  status?: ConversationStatus;
  members?: string[];
  metadata?: ConversationMetadata;
  conversationId?: string | null;
}

export interface CreateMessageInput {
  conversationId: string;
  senderType: SenderType;
  senderId?: bigint | string | null;
  content: string;
  contentType?: ContentType;
  attachments?: Attachment[];
  metadata?: MessageMetadata;
}

export interface UpdateMessageInput {
  content?: string;
  status?: MessageStatus;
  metadata?: MessageMetadata;
}

export interface CreateToolCallInput {
  messageId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface UpdateToolCallInput {
  toolOutput?: Record<string, unknown>;
  status?: ToolCallStatus;
  error?: string;
}

export interface CreateContextInput {
  conversationId: string;
  contextType: ContextType;
  content: string;
  embedding?: number[];
  tokenCount?: number;
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
}

// ============================================
// QUERY/FILTER TYPES
// ============================================

export interface ConversationFilters {
  userId?: string | bigint;
  jobId?: string | bigint;
  channelType?: ChannelType;
  status?: ConversationStatus;
  createdAfter?: Date;
  createdBefore?: Date;
}

export interface MessageFilters {
  conversationId: string;
  senderType?: SenderType;
  senderId?: bigint | string;
  contentType?: ContentType;
  status?: MessageStatus;
  createdAfter?: Date;
  createdBefore?: Date;
}

export interface PaginationParams {
  cursor?: string;
  limit?: number;
  orderBy?: "asc" | "desc";
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}
