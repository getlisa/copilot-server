import { Request, Response } from "express";
import { conversationRepository } from "../repositories/conversation.repository";
import { messageRepository } from "../repositories/message.repository";
import logger from "../../lib/logger";
import { getClaraAgent } from "../../agent/ClaraAgent";
import { AgentStreamCallbacks } from "../../types/agent.types";

export class ChatController {
  /**
   * Send a message and get AI response (non-streaming)
   * POST /chat/:conversationId/send
   */
  static async sendMessage(req: Request, res: Response) {
    const startTime = Date.now();
    const { conversationId } = req.params;
    const { content, senderId } = req.body;

    logger.info("Chat message received", { conversationId, senderId, contentLength: content?.length });

    try {
      // 1. Verify conversation exists
      const conversation = await conversationRepository.getById(conversationId);
      if (!conversation) {
        return res.status(404).json({
          success: false,
          error: "Conversation not found",
        });
      }

      // 2. Save user message
      const userMessage = await messageRepository.create({
        conversationId,
        senderType: "USER",
        senderId: senderId || "user",
        content,
        contentType: "TEXT",
      });

      logger.info("User message saved", { messageId: userMessage.id });

      // 3. Get Clara agent and process message
      const agent = await getClaraAgent();

      const response = await agent.processMessage(content, {
        conversationId,
        userId: senderId || "user",
        jobId: conversation.jobId || undefined,
      });

      // 4. Save AI response
      const aiMessage = await messageRepository.create({
        conversationId,
        senderType: "AI",
        senderId: "clara",
        content: response.content,
        contentType: "TEXT",
        metadata: response.metadata,
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

    logger.info("Chat stream started", { conversationId, senderId });

    try {
      // Verify conversation exists
      const conversation = await conversationRepository.getById(conversationId);
      if (!conversation) {
        return res.status(404).json({
          success: false,
          error: "Conversation not found",
        });
      }

      // Save user message
      const userMessage = await messageRepository.create({
        conversationId,
        senderType: "USER",
        senderId: senderId || "user",
        content,
        contentType: "TEXT",
      });

      // Set up SSE
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      // Send user message ID
      res.write(`data: ${JSON.stringify({ type: "user_message", data: userMessage })}\n\n`);

      // Get Clara agent
      const agent = await getClaraAgent();

      let fullResponse = "";

      const callbacks: AgentStreamCallbacks = {
        onThinking: () => {
          res.write(`data: ${JSON.stringify({ type: "thinking" })}\n\n`);
        },
        onTextChunk: (chunk: string, fullText: string) => {
          fullResponse = fullText;
          res.write(`data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`);
        },
        onToolCall: (toolName: string) => {
          res.write(`data: ${JSON.stringify({ type: "tool_call", tool: toolName })}\n\n`);
        },
        onError: (error: Error) => {
          res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
        },
      };

      // Process with streaming callbacks
      const response = await agent.processMessage(
        content,
        {
          conversationId,
          userId: senderId || "user",
          jobId: conversation.jobId || undefined,
        },
        callbacks
      );

      // Save complete AI response
      const aiMessage = await messageRepository.create({
        conversationId,
        senderType: "AI",
        senderId: "clara",
        content: response.content,
        contentType: "TEXT",
        metadata: response.metadata,
      });

      // Send completion event
      res.write(`data: ${JSON.stringify({ type: "done", data: aiMessage })}\n\n`);
      res.end();

      logger.info("Chat stream completed", { conversationId, messageId: aiMessage.id });
    } catch (error) {
      logger.error("Chat stream error", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.write(`data: ${JSON.stringify({ type: "error", error: "Stream failed" })}\n\n`);
      res.end();
    }
  }
}
