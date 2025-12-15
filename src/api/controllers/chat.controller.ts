import { Request, Response } from "express";
import { conversationRepository } from "../repositories/conversation.repository";
import { messageRepository } from "../repositories/message.repository";
import logger from "../../lib/logger";
import { getClaraAgent } from "../../agent/ClaraAgent";
import { AgentStreamCallbacks } from "../../types/agent.types";
import { getRecentImagesWithPresignedUrls } from "../../lib/imageAccess";
import { getPresignedUrlForKey } from "../../lib/s3";
import prisma from "../../lib/prisma";

// Redact presigned URLs for logging (strip query params)
const redactUrl = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
};

// Fetch images for vision: prefer ImageFile table; fallback to message attachments
// Default limit is 1 (latest only) to avoid mixing older context unless the client
// explicitly opts in via selectedImageIds or inlineImages.
const fetchImagesForConversation = async (conversationId: string, limit?: number) => {
  // Primary source: ImageFile rows
  const primary = await getRecentImagesWithPresignedUrls({ conversationId, limit });
  if (primary.length > 0) {
    return primary.map((img: any) => ({
      id: img.id,
      url: img.url,
      filename: img.filename ?? undefined,
      mimeType: img.mimeType,
    }));
  }

  // Fallback: recent IMAGE messages with attachments
  const fallbackMessages = await prisma.message.findMany({
    where: { conversationId, contentType: "IMAGE" },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, attachments: true },
  });

  const images: { id: string; url: string; filename?: string; mimeType?: string }[] = [];

  for (const msg of fallbackMessages) {
    const attArr = Array.isArray(msg.attachments) ? msg.attachments : [];
    for (const raw of attArr) {
      const att = raw as Record<string, any>;
      if (att?.url) {
        images.push({
          id: att.id ?? msg.id,
          url: att.url,
          filename: att.filename,
          mimeType: att.type,
        });
      } else if (att && att.metadata && att.metadata.s3Key) {
        const url = await getPresignedUrlForKey(att.metadata.s3Key);
        console.log({
          "att.metadata.s3Key": att.metadata.s3Key,
          "url": url,
          
        })
        images.push({
          id: att.id ?? msg.id,
          url,
          filename: att.filename,
          mimeType: att.type,
        });
      }
    }
  }

  return images.slice(0, limit);
};

// Fetch specific images by their ImageFile IDs (within the same conversation)
const fetchImagesByIds = async (conversationId: string, imageIds: string[]) => {
  if (imageIds.length === 0) return [];

  const files = await prisma.imageFile.findMany({
    where: { conversationId, id: { in: imageIds } },
  });

  if (files.length === 0) return [];

  const urls = await Promise.all(
    files.map((f: { s3Key: string }) => getPresignedUrlForKey(f.s3Key))
  );

  return files.map((f: any, idx: number) => ({
    id: f.id,
    url: urls[idx],
    filename: f.filename ?? undefined,
    mimeType: f.mimeType,
  }));
};

// Persist tool calls from agent metadata
const logToolCallsForMessage = async (
  messageId: string,
  toolNames?: string[]
) => {
  if (!toolNames || toolNames.length === 0) return;
  try {
    await Promise.all(
      toolNames.map(async (toolName) => {
        const toolCall = await messageRepository.createToolCall({
          messageId,
          toolName,
          toolInput: {}, // no structured input available from agent metadata
        });
        // Mark as completed immediately (agent tool executed locally)
        await messageRepository.completeToolCall(toolCall.id, {
          note: "auto-logged from agent metadata",
        });
      })
    );
  } catch (err) {
    logger.warn("Failed to persist tool calls", {
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

type InlineImageInput = { data: string; mimeType?: string };

const parseInlineImages = (raw: unknown): InlineImageInput[] => {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item: any) => {
      if (typeof item === "string") {
        return { data: item } satisfies InlineImageInput;
      }
      if (item && typeof item === "object") {
        const data = (item as any).data ?? (item as any).base64 ?? (item as any).url;
        const mimeType = (item as any).mimeType ?? (item as any).type;
        if (typeof data === "string" && data.trim()) {
          return { data, mimeType } satisfies InlineImageInput;
        }
      }
      return null;
    })
    .filter((v): v is InlineImageInput => Boolean(v && typeof v.data === "string"));
};

export class ChatController {
  /**
   * Send a message and get AI response (non-streaming)
   * POST /chat/:conversationId/send
   */
  static async sendMessage(req: Request, res: Response) {
    const startTime = Date.now();
    const { conversationId } = req.params;
    const { content, senderId } = req.body;
    const inlineImages = parseInlineImages(req.body.images ?? req.body.inlineImages);
    const senderType = senderId ? "USER" : "AI";

    logger.info("Chat message received", {
      conversationId,
      senderId: senderId ? String(senderId) : undefined,
      contentLength: content?.length,
      inlineImageCount: inlineImages.length,
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
      // Allow explicit image selection from the client; otherwise, fall back to recent 2
      const selectedImageIds = Array.isArray(req.body.selectedImageIds)
        ? (req.body.selectedImageIds as string[]).filter((v) => typeof v === "string" && v.trim())
        : [];

      const visionImages =
        inlineImages.length > 0
          ? []
          : selectedImageIds.length > 0
            ? await fetchImagesByIds(conversationId, selectedImageIds)
            : await fetchImagesForConversation(conversationId);
      const imageUrls = visionImages.map((img: { url: string }) => img.url);

      if (imageUrls.length > 0) {
        logger.info("Clara vision context (sendMessage)", {
          conversationId,
          imageCount: imageUrls.length,
          urls: imageUrls.map((u: string) => redactUrl(u)),
        });
      }

      const baseContext = {
        conversationId,
        userId: senderId ? String(senderId) : "user",
        jobId: conversation.jobId ? String(conversation.jobId) : undefined,
      };

      const response =
        inlineImages.length > 0
          ? await agent.processMessageWithImages(content, inlineImages, baseContext)
          : imageUrls.length > 0
            ? await agent.processVisionQuestion(content, imageUrls, baseContext)
            : await agent.processMessage(content, baseContext);

      // 4. Save AI response
      const aiMessage = await messageRepository.create({
        conversationId,
        senderType: "AI",
        senderId: null,
        content: response.content,
        contentType: "TEXT",
        metadata: {
          ...response.metadata,
          inlineImageCount: inlineImages.length,
          imageFileIds: visionImages.map((img: { id: string }) => img.id),
        },
      });

      // Persist tool calls (if any)
      await logToolCallsForMessage(aiMessage.id, response.metadata?.toolsUsed);

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
    const inlineImages = parseInlineImages(req.body.images ?? req.body.inlineImages);
    const senderType = senderId ? "USER" : "AI";

    logger.info("Chat stream started", {
      conversationId,
      senderId: senderId ? String(senderId) : undefined,
      senderType,
      inlineImageCount: inlineImages.length,
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
      // Allow explicit image selection from the client; otherwise, fall back to recent 2
      const selectedImageIds = Array.isArray(req.body.selectedImageIds)
        ? (req.body.selectedImageIds as string[]).filter((v) => typeof v === "string" && v.trim())
        : [];

      const visionImages =
        inlineImages.length > 0
          ? []
          : selectedImageIds.length > 0
            ? await fetchImagesByIds(conversationId, selectedImageIds)
            : await fetchImagesForConversation(conversationId, 1);
      const imageUrls = visionImages.map((img: { url: string }) => img.url);

      if (imageUrls.length > 0) {
        logger.info("Clara vision context (stream)", {
          conversationId,
          imageCount: imageUrls.length,
          urls: imageUrls.map((u: string) => redactUrl(u)),
        });
      }

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
      const baseContext = {
        conversationId,
        userId: senderId ? String(senderId) : "user",
        jobId: conversation.jobId ? String(conversation.jobId) : undefined,
      };

      const response =
        inlineImages.length > 0
          ? await agent.processMessageWithImages(content, inlineImages, baseContext, callbacks)
          : imageUrls.length > 0
            ? await agent.processVisionQuestion(content, imageUrls, baseContext, callbacks)
            : await agent.processMessage(content, baseContext, callbacks);

      // Save complete AI response
      const aiMessage = await messageRepository.create({
        conversationId,
        senderType: "AI",
        senderId: null,
        content: response.content,
        contentType: "TEXT",
        metadata: {
          ...response.metadata,
          inlineImageCount: inlineImages.length,
          imageFileIds: visionImages.map((img: { id: string }) => img.id),
        },
      });

      // Persist tool calls (if any)
      await logToolCallsForMessage(aiMessage.id, response.metadata?.toolsUsed);

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
