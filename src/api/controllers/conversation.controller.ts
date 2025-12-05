import { Response } from "express";
import { ValidatedRequest } from "../middlewares/validate";
import { conversationRepository } from "../repositories/conversation.repository";
import { messageRepository } from "../repositories/message.repository";
import { contextRepository } from "../repositories/context.repository";
import logger from "../../lib/logger";
import {
  createConversationSchema,
  getConversationSchema,
  getConversationWithMessagesSchema,
  updateConversationSchema,
  listConversationsSchema,
  closeConversationSchema,
  addMemberSchema,
  removeMemberSchema,
  createMessageSchema,
  getMessageSchema,
  updateMessageSchema,
  listMessagesSchema,
  deleteMessageSchema,
  createToolCallSchema,
  completeToolCallSchema,
  createContextSchema,
  getContextsSchema,
  getConversationStatsSchema,
} from "../schemas/conversation.schema";

// Helper to extract error details
const getErrorDetails = (error: unknown) => ({
  message: error instanceof Error ? error.message : String(error),
  name: error instanceof Error ? error.name : 'Unknown',
  stack: error instanceof Error ? error.stack : undefined,
});

export class ConversationController {
  // ============================================
  // CONVERSATION ENDPOINTS
  // ============================================

  /**
   * Create a new conversation (or return existing for the same job)
   * POST /conversations
   * Note: Each job can only have ONE conversation thread (unique constraint)
   */
  static async createConversation(
    req: ValidatedRequest<typeof createConversationSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const logContext = { 
      endpoint: 'createConversation',
      body: req.validated.body 
    };

    logger.info('Creating conversation', logContext);

    try {
      const { conversation, created } = await conversationRepository.getOrCreateByJobId(req.validated.body);
      
      if (created) {
        logger.info('Conversation created successfully', {
          ...logContext,
          conversationId: conversation.id,
          durationMs: Date.now() - startTime
        });

        res.status(201).json({
          success: true,
          data: conversation,
          created: true,
        });
      } else {
        logger.info('Returning existing conversation for job', {
          ...logContext,
          conversationId: conversation.id,
          jobId: req.validated.body.jobId,
          durationMs: Date.now() - startTime
        });

        res.status(200).json({
          success: true,
          data: conversation,
          created: false,
          message: "Conversation already exists for this job",
        });
      }
    } catch (error) {
      logger.error('Failed to create conversation', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to create conversation",
      });
    }
  }

  /**
   * Get a conversation by ID
   * GET /conversations/:conversationId
   */
  static async getConversation(
    req: ValidatedRequest<typeof getConversationSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId } = req.validated.params;
    const logContext = { endpoint: 'getConversation', conversationId };

    logger.info('Getting conversation', logContext);

    try {
      const conversation = await conversationRepository.getById(conversationId);

      if (!conversation) {
        logger.warn('Conversation not found', logContext);
        return res.status(404).json({
          success: false,
          error: "Conversation not found",
        });
      }

      logger.info('Conversation retrieved', {
        ...logContext,
        durationMs: Date.now() - startTime
      });

      res.status(200).json({
        success: true,
        data: conversation,
      });
    } catch (error) {
      logger.error('Failed to get conversation', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to get conversation",
      });
    }
  }

  /**
   * Get a conversation with messages
   * GET /conversations/:conversationId/full
   */
  static async getConversationWithMessages(
    req: ValidatedRequest<typeof getConversationWithMessagesSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId } = req.validated.params;
    const { messageLimit } = req.validated.query;
    const logContext = { endpoint: 'getConversationWithMessages', conversationId, messageLimit };

    logger.info('Getting conversation with messages', logContext);

    try {
      const conversation = await conversationRepository.getByIdWithMessages(
        conversationId,
        messageLimit
      );

      if (!conversation) {
        logger.warn('Conversation not found', logContext);
        return res.status(404).json({
          success: false,
          error: "Conversation not found",
        });
      }

      logger.info('Conversation with messages retrieved', {
        ...logContext,
        messageCount: conversation.messages?.length ?? 0,
        durationMs: Date.now() - startTime
      });

      res.status(200).json({
        success: true,
        data: conversation,
      });
    } catch (error) {
      logger.error('Failed to get conversation with messages', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to get conversation",
      });
    }
  }

  /**
   * Update a conversation
   * PATCH /conversations/:conversationId
   */
  static async updateConversation(
    req: ValidatedRequest<typeof updateConversationSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId } = req.validated.params;
    const logContext = { 
      endpoint: 'updateConversation', 
      conversationId,
      updates: req.validated.body 
    };

    logger.info('Updating conversation', logContext);

    try {
      const conversation = await conversationRepository.update(
        conversationId,
        req.validated.body
      );

      logger.info('Conversation updated', {
        ...logContext,
        durationMs: Date.now() - startTime
      });

      res.status(200).json({
        success: true,
        data: conversation,
      });
    } catch (error) {
      logger.error('Failed to update conversation', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to update conversation",
      });
    }
  }

  /**
   * List conversations with filters
   * GET /conversations
   */
  static async listConversations(
    req: ValidatedRequest<typeof listConversationsSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { cursor, limit, orderBy, ...filters } = req.validated.query;
    const logContext = { endpoint: 'listConversations', filters, cursor, limit, orderBy };

    logger.info('Listing conversations', logContext);

    try {
      const result = await conversationRepository.list(filters, {
        cursor,
        limit,
        orderBy,
      });

      logger.info('Conversations listed', {
        ...logContext,
        resultCount: result.items.length,
        total: result.total,
        hasMore: result.hasMore,
        durationMs: Date.now() - startTime
      });

      res.status(200).json({
        success: true,
        data: result.items,
        pagination: {
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
          total: result.total,
        },
      });
    } catch (error) {
      logger.error('Failed to list conversations', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to list conversations",
      });
    }
  }

  /**
   * Close a conversation
   * POST /conversations/:conversationId/close
   */
  static async closeConversation(
    req: ValidatedRequest<typeof closeConversationSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId } = req.validated.params;
    const logContext = { endpoint: 'closeConversation', conversationId };

    logger.info('Closing conversation', logContext);

    try {
      const conversation = await conversationRepository.close(conversationId);

      logger.info('Conversation closed', {
        ...logContext,
        durationMs: Date.now() - startTime
      });

      res.status(200).json({
        success: true,
        data: conversation,
      });
    } catch (error) {
      logger.error('Failed to close conversation', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to close conversation",
      });
    }
  }

  /**
   * Add a member to conversation
   * POST /conversations/:conversationId/members
   */
  static async addMember(
    req: ValidatedRequest<typeof addMemberSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId } = req.validated.params;
    const { memberId } = req.validated.body;
    const logContext = { endpoint: 'addMember', conversationId, memberId };

    logger.info('Adding member to conversation', logContext);

    try {
      const conversation = await conversationRepository.addMember(
        conversationId,
        memberId
      );

      logger.info('Member added', {
        ...logContext,
        memberCount: conversation.members.length,
        durationMs: Date.now() - startTime
      });

      res.status(200).json({
        success: true,
        data: conversation,
      });
    } catch (error) {
      logger.error('Failed to add member', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to add member",
      });
    }
  }

  /**
   * Remove a member from conversation
   * DELETE /conversations/:conversationId/members/:memberId
   */
  static async removeMember(
    req: ValidatedRequest<typeof removeMemberSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId, memberId } = req.validated.params;
    const logContext = { endpoint: 'removeMember', conversationId, memberId };

    logger.info('Removing member from conversation', logContext);

    try {
      const conversation = await conversationRepository.removeMember(
        conversationId,
        memberId
      );

      logger.info('Member removed', {
        ...logContext,
        memberCount: conversation.members.length,
        durationMs: Date.now() - startTime
      });

      res.status(200).json({
        success: true,
        data: conversation,
      });
    } catch (error) {
      logger.error('Failed to remove member', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to remove member",
      });
    }
  }

  /**
   * Get conversation statistics
   * GET /conversations/:conversationId/stats
   */
  static async getConversationStats(
    req: ValidatedRequest<typeof getConversationStatsSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId } = req.validated.params;
    const logContext = { endpoint: 'getConversationStats', conversationId };

    logger.info('Getting conversation stats', logContext);

    try {
      const [stats, toolCallStats] = await Promise.all([
        conversationRepository.getStats(conversationId),
        messageRepository.getToolCallStats(conversationId),
      ]);

      logger.info('Stats retrieved', {
        ...logContext,
        messageCount: stats.messageCount,
        durationMs: Date.now() - startTime
      });

      res.status(200).json({
        success: true,
        data: {
          ...stats,
          toolCalls: toolCallStats,
        },
      });
    } catch (error) {
      logger.error('Failed to get conversation stats', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to get stats",
      });
    }
  }

  // ============================================
  // MESSAGE ENDPOINTS
  // ============================================

  /**
   * Create a message in a conversation
   * POST /conversations/:conversationId/messages
   */
  static async createMessage(
    req: ValidatedRequest<typeof createMessageSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId } = req.validated.params;
    const logContext = { 
      endpoint: 'createMessage', 
      conversationId,
      senderType: req.validated.body.senderType,
      contentType: req.validated.body.contentType,
      contentLength: req.validated.body.content?.length
    };

    logger.info('Creating message', logContext);

    try {
      const message = await messageRepository.createWithConversationUpdate({
        conversationId,
        ...req.validated.body,
      });

      logger.info('Message created', {
        ...logContext,
        messageId: message.id,
        durationMs: Date.now() - startTime
      });

      res.status(201).json({
        success: true,
        data: message,
      });
    } catch (error) {
      logger.error('Failed to create message', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to create message",
      });
    }
  }

  /**
   * Get a message by ID
   * GET /conversations/:conversationId/messages/:messageId
   */
  static async getMessage(
    req: ValidatedRequest<typeof getMessageSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId, messageId } = req.validated.params;
    const logContext = { endpoint: 'getMessage', conversationId, messageId };

    logger.info('Getting message', logContext);

    try {
      const message = await messageRepository.getByIdWithToolCalls(messageId);

      if (!message) {
        logger.warn('Message not found', logContext);
        return res.status(404).json({
          success: false,
          error: "Message not found",
        });
      }

      logger.info('Message retrieved', {
        ...logContext,
        durationMs: Date.now() - startTime
      });

      res.status(200).json({
        success: true,
        data: message,
      });
    } catch (error) {
      logger.error('Failed to get message', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to get message",
      });
    }
  }

  /**
   * Update a message
   * PATCH /conversations/:conversationId/messages/:messageId
   */
  static async updateMessage(
    req: ValidatedRequest<typeof updateMessageSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId, messageId } = req.validated.params;
    const logContext = { 
      endpoint: 'updateMessage', 
      conversationId, 
      messageId,
      updates: Object.keys(req.validated.body)
    };

    logger.info('Updating message', logContext);

    try {
      const message = await messageRepository.update(messageId, req.validated.body);

      logger.info('Message updated', {
        ...logContext,
        durationMs: Date.now() - startTime
      });

      res.status(200).json({
        success: true,
        data: message,
      });
    } catch (error) {
      logger.error('Failed to update message', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to update message",
      });
    }
  }

  /**
   * List messages in a conversation
   * GET /conversations/:conversationId/messages
   */
  static async listMessages(
    req: ValidatedRequest<typeof listMessagesSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId } = req.validated.params;
    const { cursor, limit, orderBy, ...filters } = req.validated.query;
    const logContext = { 
      endpoint: 'listMessages', 
      conversationId, 
      filters, 
      cursor, 
      limit 
    };

    logger.info('Listing messages', logContext);

    try {
      const result = await messageRepository.list(
        { conversationId, ...filters },
        { cursor, limit, orderBy }
      );

      logger.info('Messages listed', {
        ...logContext,
        resultCount: result.items.length,
        total: result.total,
        durationMs: Date.now() - startTime
      });

      res.status(200).json({
        success: true,
        data: result.items,
        pagination: {
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
          total: result.total,
        },
      });
    } catch (error) {
      logger.error('Failed to list messages', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to list messages",
      });
    }
  }

  /**
   * Delete a message (soft delete)
   * DELETE /conversations/:conversationId/messages/:messageId
   */
  static async deleteMessage(
    req: ValidatedRequest<typeof deleteMessageSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId, messageId } = req.validated.params;
    const logContext = { endpoint: 'deleteMessage', conversationId, messageId };

    logger.info('Deleting message', logContext);

    try {
      const message = await messageRepository.softDelete(messageId);

      logger.info('Message deleted (soft)', {
        ...logContext,
        durationMs: Date.now() - startTime
      });

      res.status(200).json({
        success: true,
        data: message,
      });
    } catch (error) {
      logger.error('Failed to delete message', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to delete message",
      });
    }
  }

  // ============================================
  // TOOL CALL ENDPOINTS
  // ============================================

  /**
   * Create a tool call record
   * POST /conversations/:conversationId/messages/:messageId/tool-calls
   */
  static async createToolCall(
    req: ValidatedRequest<typeof createToolCallSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId, messageId } = req.validated.params;
    const logContext = { 
      endpoint: 'createToolCall', 
      conversationId, 
      messageId,
      toolName: req.validated.body.toolName
    };

    logger.info('Creating tool call', logContext);

    try {
      const toolCall = await messageRepository.createToolCall({
        messageId,
        ...req.validated.body,
      });

      logger.info('Tool call created', {
        ...logContext,
        toolCallId: toolCall.id,
        durationMs: Date.now() - startTime
      });

      res.status(201).json({
        success: true,
        data: toolCall,
      });
    } catch (error) {
      logger.error('Failed to create tool call', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to create tool call",
      });
    }
  }

  /**
   * Complete a tool call
   * PATCH /conversations/:conversationId/messages/:messageId/tool-calls/:toolCallId
   */
  static async completeToolCall(
    req: ValidatedRequest<typeof completeToolCallSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId, messageId, toolCallId } = req.validated.params;
    const { toolOutput, error: toolError } = req.validated.body;
    const logContext = { 
      endpoint: 'completeToolCall', 
      conversationId, 
      messageId,
      toolCallId,
      hasError: !!toolError
    };

    logger.info('Completing tool call', logContext);

    try {
      let toolCall;
      if (toolError) {
        toolCall = await messageRepository.failToolCall(toolCallId, toolError);
        logger.warn('Tool call failed', { ...logContext, error: toolError });
      } else {
        toolCall = await messageRepository.completeToolCall(
          toolCallId,
          toolOutput ?? {}
        );
        logger.info('Tool call completed', {
          ...logContext,
          durationMs: Date.now() - startTime
        });
      }

      res.status(200).json({
        success: true,
        data: toolCall,
      });
    } catch (error) {
      logger.error('Failed to complete tool call', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to complete tool call",
      });
    }
  }

  // ============================================
  // CONTEXT ENDPOINTS
  // ============================================

  /**
   * Create a context entry
   * POST /conversations/:conversationId/context
   */
  static async createContext(
    req: ValidatedRequest<typeof createContextSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId } = req.validated.params;
    const logContext = { 
      endpoint: 'createContext', 
      conversationId,
      contextType: req.validated.body.contextType,
      contentLength: req.validated.body.content?.length
    };

    logger.info('Creating context', logContext);

    try {
      const context = await contextRepository.create({
        conversationId,
        ...req.validated.body,
      });

      logger.info('Context created', {
        ...logContext,
        contextId: context.id,
        durationMs: Date.now() - startTime
      });

      res.status(201).json({
        success: true,
        data: context,
      });
    } catch (error) {
      logger.error('Failed to create context', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to create context",
      });
    }
  }

  /**
   * Get contexts for a conversation
   * GET /conversations/:conversationId/context
   */
  static async getContexts(
    req: ValidatedRequest<typeof getContextsSchema>,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId } = req.validated.params;
    const { contextType } = req.validated.query;
    const logContext = { endpoint: 'getContexts', conversationId, contextType };

    logger.info('Getting contexts', logContext);

    try {
      let contexts;
      if (contextType) {
        contexts = await contextRepository.getByType(conversationId, contextType);
      } else {
        contexts = await contextRepository.getByConversationId(conversationId);
      }

      logger.info('Contexts retrieved', {
        ...logContext,
        count: contexts.length,
        durationMs: Date.now() - startTime
      });

      res.status(200).json({
        success: true,
        data: contexts,
      });
    } catch (error) {
      logger.error('Failed to get contexts', {
        ...logContext,
        ...getErrorDetails(error),
        durationMs: Date.now() - startTime
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to get contexts",
      });
    }
  }
}
