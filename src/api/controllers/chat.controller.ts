import { Request, Response } from "express";
import { conversationRepository } from "../repositories/conversation.repository";
import { messageRepository } from "../repositories/message.repository";
import logger from "../../lib/logger";
import { getClaraAgent } from "../../agent/ClaraAgent";
import { AgentStreamCallbacks } from "../../types/agent.types";
import { getRecentImagesWithPresignedUrls } from "../../lib/imageAccess";
import prisma from "../../lib/prisma";

export class ChatController {
  /**
   * Send a message and get AI response (non-streaming)
   * POST /chat/:conversationId/send
   */
  static async sendMessage(req: Request, res: Response) {
    const startTime = Date.now();
    const { conversationId } = req.params;
    const { content, senderId } = req.body;
    const senderType = senderId ? "USER" : "AI";

    logger.info("Chat message received", {
      conversationId,
      senderId: senderId ? String(senderId) : undefined,
      contentLength: content?.length,
    });

    try {
      // 1. Verify conversation exists
      const conversation = await conversationRepository.getById(conversationId);
      if (!conversation) {
        return res.status(404).json({
          success: false,
          error: "Conversation not found",
        });
      }

      // 2. Deduplicate: if the last user IMAGE message has the same content, reuse it
      let userMessage = null as any;
      if (senderType === "USER") {
        const lastImage = await prisma.message.findFirst({
          where: {
            conversationId,
            senderType: "USER",
            contentType: "IMAGE",
          },
          orderBy: { createdAt: "desc" },
        });

        if (
          lastImage &&
          lastImage.content === content &&
          (lastImage.senderId === null ||
            (senderId && String(lastImage.senderId) === String(senderId)))
        ) {
          userMessage = lastImage;
          logger.info("Reusing last image message to avoid duplicate text", {
            conversationId,
            messageId: lastImage.id,
          });
        }
      }

      // If not reused, create the user text message
      if (!userMessage) {
        userMessage = await messageRepository.create({
          conversationId,
          senderType,
          senderId: senderId ? BigInt(senderId) : null,
          content,
          contentType: "TEXT",
        });
      }

      logger.info("Message saved", { messageId: userMessage.id, senderType });

      // If this is an AI-authored message (senderId is null), just persist it.
      if (senderType === "AI") {
        return res.status(200).json({
          success: true,
          data: {
            userMessage,
            aiMessage: userMessage,
          },
        });
      }

      // 3. Get Clara agent and process message (with images if available)
      const agent = await getClaraAgent();
      const recentImages = await getRecentImagesWithPresignedUrls({
        conversationId,
        limit: 4,
      });
      const imageUrls = recentImages.map((img) => img.url);

      const response =
        imageUrls.length > 0
          ? await agent.processVisionQuestion(content, imageUrls, {
              conversationId,
              userId: senderId ? String(senderId) : "user",
              jobId: conversation.jobId ? String(conversation.jobId) : undefined,
            })
          : await agent.processMessage(content, {
              conversationId,
              userId: senderId ? String(senderId) : "user",
              jobId: conversation.jobId ? String(conversation.jobId) : undefined,
            });

      // 4. Save AI response
      const aiMessage = await messageRepository.create({
        conversationId,
        senderType: "AI",
        senderId: null,
        content: response.content,
        contentType: "TEXT",
        metadata: {
          ...response.metadata,
          imageFileIds: recentImages.map((img) => img.id),
        },
      });

      logger.info("AI response saved", {
        messageId: aiMessage.id,
        durationMs: Date.now() - startTime,
      });

      res.status(200).json({
        success: true,
        data: {
          userMessage,
          aiMessage,
        },
      });
    } catch (error) {
      logger.error("Chat error", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        durationMs: Date.now() - startTime,
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to process message",
      });
    }
  }

  /**
   * Send a message and stream AI response (SSE)
   * POST /chat/:conversationId/stream
   */
  static async streamMessage(req: Request, res: Response) {
    const { conversationId } = req.params;
    const { content, senderId } = req.body;
    const senderType = senderId ? "USER" : "AI";

    logger.info("Chat stream started", {
      conversationId,
      senderId: senderId ? String(senderId) : undefined,
      senderType,
    });

    const flush = () => {
      (res as any).flush?.();
    };

    try {
      // Verify conversation exists
      const conversation = await conversationRepository.getById(conversationId);
      if (!conversation) {
        return res.status(404).json({
          success: false,
          error: "Conversation not found",
        });
      }

      // Deduplicate: if the last user IMAGE message has the same content, reuse it
      let userMessage = null as any;
      if (senderType === "USER") {
        const lastImage = await prisma.message.findFirst({
          where: {
            conversationId,
            senderType: "USER",
            contentType: "IMAGE",
          },
          orderBy: { createdAt: "desc" },
        });

        if (
          lastImage &&
          lastImage.content === content &&
          (lastImage.senderId === null ||
            (senderId && String(lastImage.senderId) === String(senderId)))
        ) {
          userMessage = lastImage;
          logger.info("Reusing last image message to avoid duplicate text (stream)", {
            conversationId,
            messageId: lastImage.id,
          });
        }
      }

      // If not reused, create the user text message
      if (!userMessage) {
        userMessage = await messageRepository.create({
          conversationId,
          senderType,
          senderId: senderId ? BigInt(senderId) : null,
          content,
          contentType: "TEXT",
        });
      }

      // If this is an AI-authored message (senderId is null), just stream it back and end.
      if (senderType === "AI") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        res.write(`data: ${JSON.stringify({ type: "done", data: userMessage })}\n\n`);
        res.end();
        return;
      }

      // Set up SSE
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      // Hint proxies/CDNs not to buffer SSE
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // Heartbeat to keep idle connections alive behind proxies
      const heartbeat = setInterval(() => {
        res.write(":\n\n");
        flush();
      }, 25000);

      // Send user message ID
      res.write(`data: ${JSON.stringify({ type: "user_message", data: userMessage })}\n\n`);
      flush();

      // Get Clara agent and prepare image context
      const agent = await getClaraAgent();
      const recentImages = await getRecentImagesWithPresignedUrls({
        conversationId,
        limit: 4,
      });
      const imageUrls = recentImages.map((img) => img.url);

      let fullResponse = "";

      const callbacks: AgentStreamCallbacks = {
        onThinking: () => {
          res.write(`data: ${JSON.stringify({ type: "thinking" })}\n\n`);
          flush();
        },
        onTextChunk: (chunk: string, fullText: string) => {
          fullResponse = fullText;
          res.write(`data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`);
          flush();
        },
        onToolCall: (toolName: string) => {
          res.write(`data: ${JSON.stringify({ type: "tool_call", tool: toolName })}\n\n`);
          flush();
        },
        onError: (error: Error) => {
          res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
          flush();
        },
      };

      // Process with streaming callbacks (vision if images available)
      const response =
        imageUrls.length > 0
          ? await agent.processVisionQuestion(
              content,
              imageUrls,
              {
                conversationId,
                userId: senderId ? String(senderId) : "user",
                jobId: conversation.jobId ? String(conversation.jobId) : undefined,
              },
              callbacks
            )
          : await agent.processMessage(
              content,
              {
                conversationId,
                userId: senderId ? String(senderId) : "user",
                jobId: conversation.jobId ? String(conversation.jobId) : undefined,
              },
              callbacks
            );

      // Save complete AI response
      const aiMessage = await messageRepository.create({
        conversationId,
        senderType: "AI",
        senderId: null,
        content: response.content,
        contentType: "TEXT",
        metadata: {
          ...response.metadata,
          imageFileIds: recentImages.map((img) => img.id),
        },
      });

      // Send completion event
      res.write(`data: ${JSON.stringify({ type: "done", data: aiMessage })}\n\n`);
      flush();
      res.end();
      clearInterval(heartbeat);

      logger.info("Chat stream completed", { conversationId, messageId: aiMessage.id });
    } catch (error) {
      logger.error("Chat stream error", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.write(`data: ${JSON.stringify({ type: "error", error: "Stream failed" })}\n\n`);
      flush();
      res.end();
    }
  }
}
