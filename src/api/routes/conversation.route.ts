import { Router } from "express";
import { authMiddleware } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { ConversationController } from "../controllers/conversation.controller";
import { imageUpload } from "../middlewares/imageUpload";
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
  uploadImagesSchema,
} from "../schemas/conversation.schema";
import { withValidatedRequest } from "../middlewares/withValidatedRequest";

const conversationRoute = Router();

// Apply auth middleware to all routes
conversationRoute.use(authMiddleware);

// ============================================
// CONVERSATION ROUTES
// ============================================

/**
 * @route   POST /conversations
 * @desc    Create a new conversation
 * @access  Private
 */
conversationRoute.post(
  "/",
  validate(createConversationSchema),
  withValidatedRequest(ConversationController.createConversation)
);

/**
 * @route   GET /conversations/:conversationId
 * @desc    Get a conversation by ID
 * @access  Private
 */
conversationRoute.get(
  "/:conversationId",
  validate(getConversationSchema),
  withValidatedRequest(ConversationController.getConversation)
);

/**
 * @route   GET /conversations/:conversationId/full
 * @desc    Get a conversation with all messages
 * @access  Private
 */
conversationRoute.get(
  "/:jobId/full",
  validate(getConversationWithMessagesSchema),
  withValidatedRequest(ConversationController.getConversationWithMessages)
);

/**
 * @route   GET /conversations/:conversationId/stats
 * @desc    Get conversation statistics
 * @access  Private
 */
conversationRoute.get(
  "/:conversationId/stats",
  validate(getConversationStatsSchema),
  withValidatedRequest(ConversationController.getConversationStats)
);

// ============================================
// MESSAGE ROUTES
// ============================================

/**
 * @route   POST /conversations/:conversationId/images
 * @desc    Upload up to 4 images, store in S3, attach to message
 * @access  Private
 */
conversationRoute.post(
  "/:conversationId/images",
  imageUpload.array("images", 4),
  validate(uploadImagesSchema),
  withValidatedRequest(ConversationController.uploadImages)
);

/**
 * @route   GET /conversations/:conversationId/messages
 * @desc    List messages in a conversation
 * @access  Private
 */
conversationRoute.get(
  "/:conversationId/messages",
  validate(listMessagesSchema),
  withValidatedRequest(ConversationController.listMessages)
);

/**
 * @route   POST /conversations/:conversationId/messages
 * @desc    Create a message in a conversation
 * @access  Private
 */
conversationRoute.post(
  "/:conversationId/messages",
  validate(createMessageSchema),
  withValidatedRequest(ConversationController.createMessage)
);

/**
 * @route   GET /conversations/:conversationId/messages/:messageId
 * @desc    Get a message by ID
 * @access  Private
 */
conversationRoute.get(
  "/:conversationId/messages/:messageId",
  validate(getMessageSchema),
  withValidatedRequest(ConversationController.getMessage)
);

/**
 * @route   PATCH /conversations/:conversationId/messages/:messageId
 * @desc    Update a message
 * @access  Private
 */
conversationRoute.patch(
  "/:conversationId/messages/:messageId",
  validate(updateMessageSchema),
  withValidatedRequest(ConversationController.updateMessage)
);

/**
 * @route   DELETE /conversations/:conversationId/messages/:messageId
 * @desc    Delete a message (soft delete)
 * @access  Private
 */
conversationRoute.delete(
  "/:conversationId/messages/:messageId",
  validate(deleteMessageSchema),
  withValidatedRequest(ConversationController.deleteMessage)
);

// ============================================
// TOOL CALL ROUTES
// ============================================

/**
 * @route   POST /conversations/:conversationId/messages/:messageId/tool-calls
 * @desc    Create a tool call record
 * @access  Private
 */
conversationRoute.post(
  "/:conversationId/messages/:messageId/tool-calls",
  validate(createToolCallSchema),
  withValidatedRequest(ConversationController.createToolCall)
);

/**
 * @route   PATCH /conversations/:conversationId/messages/:messageId/tool-calls/:toolCallId
 * @desc    Complete a tool call
 * @access  Private
 */
conversationRoute.patch(
  "/:conversationId/messages/:messageId/tool-calls/:toolCallId",
  validate(completeToolCallSchema),
  withValidatedRequest(ConversationController.completeToolCall)
);

// ============================================
// CONTEXT ROUTES
// ============================================

/**
 * @route   GET /conversations/:conversationId/context
 * @desc    Get contexts for a conversation
 * @access  Private
 */
conversationRoute.get(
  "/:conversationId/context",
  validate(getContextsSchema),
  withValidatedRequest(ConversationController.getContexts)
);

/**
 * @route   POST /conversations/:conversationId/context
 * @desc    Create a context entry
 * @access  Private
 */
conversationRoute.post(
  "/:conversationId/context",
  validate(createContextSchema),
  withValidatedRequest(ConversationController.createContext)
);

export { conversationRoute };

