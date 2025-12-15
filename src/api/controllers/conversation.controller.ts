import { Response } from "express";
import { randomUUID } from "crypto";
import { ValidatedRequest } from "../middlewares/validate";
import { conversationRepository } from "../repositories/conversation.repository";
import { messageRepository } from "../repositories/message.repository";
import { contextRepository } from "../repositories/context.repository";
import logger from "../../lib/logger";
import prisma from "../../lib/prisma";
import { getPresignedUrlForKey, uploadBufferToS3 } from "../../lib/s3";
import { trackFileEvent } from "../../lib/events";
import { getClaraAgent } from "../../agent/ClaraAgent";
import { generateImageEmbedding } from "../../lib/embeddings";
import { RequestWithUser } from "../middlewares/auth";
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
import { Message, ConversationWithMessages } from "../../types/conversation.types";

// Helper to extract error details
const getErrorDetails = (error: unknown) => ({
  message: error instanceof Error ? error.message : String(error),
  name: error instanceof Error ? error.name : 'Unknown',
  stack: error instanceof Error ? error.stack : undefined,
});

type ImageFile = {
  id: string;
  createdAt?: Date;
  updatedAt?: Date;
  conversationId: string;
  messageId: string;
  s3Key: string;
  mimeType: string;
  sizeBytes: bigint | null;
  filename: string | null;
};

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
      if (req.validated.body.jobId === null) {
        return res.status(400).json({
          success: false,
          error: "jobId is required",
        });
      }

      const { conversation, created } = await conversationRepository.getOrCreateByJobIdAndUserId({
        ...req.validated.body,
        jobId: req.validated.body.jobId,
      });
      
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
    req: ValidatedRequest<typeof getConversationWithMessagesSchema> & RequestWithUser,
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId, jobId } = req.validated.params;
    // Cap history to the last 10 messages unless a smaller limit is provided.
    const { messageLimit } = req.validated.query;
    const effectiveLimit = Math.min(messageLimit ?? 10, 10);
    const requesterUserId = req.user?.userId ?? null;
    const logContext = {
      endpoint: 'getConversationWithMessages',
      conversationId,
      jobId,
      messageLimit,
      requesterUserId,
    };

    try {
      const conversations: ConversationWithMessages[] = [];

      if (conversationId) {
        const conversation = await conversationRepository.getByIdWithMessages(
          conversationId,
          effectiveLimit
        );
        if (conversation) conversations.push(conversation);
      } else if (jobId) {
        const convoList =
          await conversationRepository.getByJobIdForUserOrPublicWithMessages(
            jobId,
            requesterUserId,
            effectiveLimit
          );
        conversations.push(...convoList);
      }

      // Refresh image attachments with fresh presigned URLs
      for (const conversation of conversations) {
        if (conversation && Array.isArray(conversation.messages)) {
          const imageMessages = conversation.messages.filter(
            (m: Message) => m.contentType === "IMAGE"
          );

          if (imageMessages.length > 0) {
            const imageFiles = await prisma.imageFile.findMany({
              where: { messageId: { in: imageMessages.map((m: Message) => m.id) } },
            });

            const byMessage: Record<string, ImageFile[]> = imageFiles.reduce(
              (acc: Record<string, ImageFile[]>, rec: ImageFile) => {
                const arr = acc[rec.messageId] || [];
                arr.push(rec);
                acc[rec.messageId] = arr;
                return acc;
              },
              {}
            );

            for (const msg of imageMessages) {
              const files = byMessage[msg.id] || [];
              if (files.length === 0) continue;
              const urls = await Promise.all(files.map(async (f: ImageFile) => await getPresignedUrlForKey(f.s3Key)));

              msg.attachments = await Promise.all(
                files.map(async (f: ImageFile, index: number) => ({
                  id: f.id,
                  url: urls[index],
                  type: f.mimeType,
                  filename: f.filename ?? undefined,
                  size: f.sizeBytes ? Number(f.sizeBytes) : undefined,
                  metadata: { s3Key: f.s3Key },
                }))
              );
            }
          }
        }
      }

      if (conversations.length === 0) {
        logger.warn('Conversation not found', logContext);
        return res.status(404).json({
          success: false,
          error: "Conversation not found",
        });
      }

      const messages = conversations.flatMap((c) => c.messages ?? []);
      res.status(200).json({
        success: true,
        data: {
          messages,
        },
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
   * Upload images to a conversation, create an IMAGE message, and return presigned URLs
   * POST /conversations/:conversationId/images
   */
  static async uploadImages(
    req: ValidatedRequest<typeof uploadImagesSchema> &
      RequestWithUser & { files?: Express.Multer.File[] },
    res: Response
  ) {
    const startTime = Date.now();
    const { conversationId } = req.validated.params;
    const files = req.files ?? [];
    const origin = req.validated.body.origin ?? "chat";
    const client = req.validated.body.client ?? "web";
    const logContext = {
      endpoint: "uploadImages",
      conversationId,
      fileCount: files.length,
    };

    logger.info("Uploading images", logContext);

    try {
      if (files.length === 0) {
        trackFileEvent("Upload File Initiated", {
          conversationId,
          origin,
          client,
          status: "no_files",
        });
        return res.status(400).json({
          success: false,
          error: "No images were uploaded",
        });
      }

      const conversation = await conversationRepository.getById(conversationId);
      if (!conversation) {
        logger.warn("Conversation not found for upload", logContext);
        trackFileEvent("Upload File Initiated", {
          conversationId,
          origin,
          client,
          status: "conversation_not_found",
        });
        return res.status(404).json({
          success: false,
          error: "Conversation not found",
        });
      }

      const senderId =
        req.user?.userId && /^\d+$/.test(req.user.userId) ? req.user.userId : null;

      const messageId = randomUUID();
      const companyId =
        req.user?.companyId !== undefined && req.user?.companyId !== null
          ? String(req.user.companyId)
          : "unknown-company";

      // High-level "upload initiated" event for analytics
      trackFileEvent("Upload File Initiated", {
        conversationId,
        messageId,
        origin,
        client,
        status: "initiated",
      });

      const uploads = await Promise.all(
        files.map(async (file) => {
          const imageFileId = randomUUID();
          const attachmentId = randomUUID();

          const extMatch = file.originalname.match(/\.[^.]+$/);
          const ext = extMatch ? extMatch[0] : "";
          const safeBase = file.originalname
            .replace(/\.[^.]+$/, "")
            .replace(/[^a-zA-Z0-9-_]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-+|-+$/g, "") || "image";
          const key = `companies/${companyId}/conversations/${conversationId}/messages/${messageId}/${Date.now()}-${safeBase}${ext}`;

          // Emit granular blob-store lifecycle events around S3 upload
          trackFileEvent("Blob Store Upload Started", {
            conversationId,
            messageId,
            fileId: imageFileId,
            fileName: file.originalname,
            fileSize: file.size,
            mimeType: file.mimetype,
            origin,
            client,
            status: "uploading",
            useCase: "multimodal",
            uploadEntry: "local",
          });

          await uploadBufferToS3({
            key,
            buffer: file.buffer,
            contentType: file.mimetype,
          });

          trackFileEvent("Blob Store Upload Completed", {
            conversationId,
            messageId,
            fileId: imageFileId,
            fileName: file.originalname,
            fileSize: file.size,
            mimeType: file.mimetype,
            origin,
            client,
            status: "uploaded",
            useCase: "multimodal",
            uploadEntry: "local",
          });

          const presignedUrl = await getPresignedUrlForKey(key);

          return {
            imageFile: {
              id: imageFileId,
              conversationId,
              messageId: "", // set after message creation
              s3Key: key,
              mimeType: file.mimetype,
              sizeBytes: BigInt(file.size),
              filename: file.originalname,
              embedding: await generateImageEmbedding(file.buffer),
            },
            attachment: {
              id: attachmentId,
              url: presignedUrl,
              type: file.mimetype,
              filename: file.originalname,
              size: file.size,
              metadata: {
                s3Key: key,
              },
            },
          };
        })
      );

      const content = (req.validated.body.question ?? "").trim();
      const attachments = uploads.map((u) => u.attachment);

      const message = await messageRepository.createWithConversationUpdate({
        id: messageId,
        conversationId,
        senderType: "USER",
        senderId,
        content,
        contentType: "IMAGE",
        attachments,
        metadata: {
          uploadCount: files.length,
        },
      });

      // Log uploaded image URLs
      logger.info("Images uploaded with URLs", {
        ...logContext,
        messageId: message.id,
        urls: attachments.map((att) => att.url),
      });

      await prisma.$transaction(
        uploads.map((u) =>
          prisma.$executeRaw`
            INSERT INTO image_files (id, conversation_id, message_id, s3_key, mime_type, size_bytes, filename, embeddings, created_at, updated_at)
            VALUES (
              ${u.imageFile.id},
              ${conversationId},
              ${message.id},
              ${u.imageFile.s3Key},
              ${u.imageFile.mimeType},
              ${u.imageFile.sizeBytes ?? null},
              ${u.imageFile.filename ?? null},
              ${null},
              NOW(),
              NOW()
            )
          `
        )
      );

      // Persist embeddings (if available) using raw SQL (avoids Prisma type mismatch on vector)
      for (const u of uploads) {
        if (u.imageFile.embedding && Array.isArray(u.imageFile.embedding) && u.imageFile.embedding.length > 0) {
          const vectorLiteral = `[${u.imageFile.embedding.join(",")}]`;
          try {
            await prisma.$executeRawUnsafe(
              vectorLiteral,
              u.imageFile.id
            );
          } catch (err) {
            logger.warn("Failed to persist image embedding", {
              imageFileId: u.imageFile.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      logger.info("Images uploaded", {
        ...logContext,
        messageId: message.id,
        durationMs: Date.now() - startTime,
      });

      // Final completion event for the upload lifecycle
      uploads.forEach((u) => {
        trackFileEvent("Upload File Completed", {
          conversationId,
          messageId: message.id,
          fileId: u.imageFile.id,
          fileName: u.imageFile.filename,
          fileSize: Number(u.imageFile.sizeBytes),
          mimeType: u.imageFile.mimeType,
          origin,
          client,
          status: "ready",
          useCase: "multimodal",
          uploadEntry: "local",
        });
      });

      // Immediately analyze the uploaded images with Clara (best-effort; non-blocking on failure)
      let aiMessage = null as any;
      try {
        const agent = await getClaraAgent();
        const imageUrls = attachments.map((att) => att.url);
        const baseContext = {
          conversationId,
          userId: senderId ?? (req.user?.userId ?? "user"),
          jobId: conversation.jobId ? String(conversation.jobId) : undefined,
        };

        // Small delay to ensure presigned URLs propagate (best-effort)
        await new Promise((resolve) => setTimeout(resolve, 8000));
        console.log({
          "imageUrls": imageUrls,
          "baseContext": baseContext,
          "content": content,
        })

        logger.info("Calling vision with presigned URLs", { imageUrls });
        const aiResponse = await agent.processVisionQuestion(content, imageUrls, baseContext);

        aiMessage = await messageRepository.create({
          conversationId,
          senderType: "AI",
          senderId: null,
          content: aiResponse.content,
          contentType: "TEXT",
          metadata: {
            ...aiResponse.metadata,
            imageFileIds: uploads.map((u) => u.imageFile.id),
            inlineImageCount: 0,
          },
        });

        logger.info("AI vision analysis completed for uploaded images", {
          ...logContext,
          aiMessageId: aiMessage.id,
          aiResponseSnippet: aiResponse.content?.slice(0, 500),
        });
      } catch (analysisError) {
        logger.warn("AI vision analysis failed after upload", {
          ...logContext,
          error: analysisError instanceof Error ? analysisError.message : String(analysisError),
        });
      }

      res.status(201).json({
        success: true,
        data: {
          message: {
            ...message,
            attachments,
          },
          aiMessage: aiMessage ?? undefined,
        },
      });
    } catch (error) {
      logger.error("Failed to upload images", {
        ...logContext,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to upload images",
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
