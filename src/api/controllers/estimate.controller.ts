import { Request, Response } from "express";
import { randomUUID } from "crypto";
import logger from "../../lib/logger";
import { conversationRepository } from "../repositories/conversation.repository";
import { messageRepository } from "../repositories/message.repository";
import {
  streamEstimate,
  extractQuote,
  type EstimateTurn,
} from "../../copilot/estimate/estimateService";

/**
 * DEMO-ONLY estimate-cost controller.
 *
 * Parallel SSE endpoint that runs the self-contained estimate engine
 * (`src/copilot/estimate/*`). It is independent of the live copilot controller,
 * prompt, and LangGraph workflow.
 *
 * POST /api/v1/copilot/:conversationId/estimate/stream
 * SSE frames: user_message · thinking · chunk · quote · done · error
 */

const HISTORY_LIMIT = 8;
const ESTIMATE_MODEL =
  process.env.ESTIMATE_MODEL || process.env.OPENAI_AGENT_MODEL || "gpt-4o";

/** Abort the model run if the client disconnects before the response completes. */
function abortSignalForHttpRequest(res: Response): AbortSignal {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

export class EstimateController {
  static async stream(req: Request, res: Response) {
    const { conversationId } = req.params;
    const content: string = req.body?.content ?? "";
    const senderId = req.body?.senderId;
    const imageUrl: string | undefined = req.body?.imageUrl;
    const imageBase64: string | undefined = req.body?.imageBase64;
    const imageMimeType: string | undefined = req.body?.imageMimeType;

    try {
      const conversation = await conversationRepository.getById(conversationId);
      if (!conversation) {
        return res
          .status(404)
          .json({ success: false, error: { status: 404, message: "Conversation not found" } });
      }

      const hasImage = Boolean(imageUrl || imageBase64);
      // Persist the user message (note the photo + an estimate-mode marker).
      const userMessage = await messageRepository.createWithConversationUpdate({
        conversationId,
        senderType: "USER",
        senderId: senderId ?? conversation.userId ?? null,
        content: content || (hasImage ? "[photo] Estimate request" : "Estimate request"),
        contentType: hasImage ? "IMAGE" : "TEXT",
        metadata: { mode: "estimate", hasImage },
      });

      // SSE setup (mirrors the live copilot controller framing).
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      const flush = () => (res as any).flush?.();
      const send = (payload: { type: string; [key: string]: unknown }) => {
        res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
        flush();
      };

      const heartbeat = setInterval(() => {
        res.write(":\n\n");
        flush();
      }, 25000);

      send({ type: "user_message", data: userMessage });
      send({ type: "thinking" });

      // Short text history for continuity (exclude the just-saved user message).
      const recent = await messageRepository.getLastMessages(conversationId, HISTORY_LIMIT + 1);
      const history: EstimateTurn[] = recent
        .filter((m) => m.id !== userMessage.id && Boolean(m.content))
        .map((m) => ({
          role: m.senderType === "AI" ? ("assistant" as const) : ("user" as const),
          content: m.content as string,
        }));

      const signal = abortSignalForHttpRequest(res);
      const runId = randomUUID();

      // 1) Stream the markdown estimate.
      const { text, usage } = await streamEstimate(
        { content, imageUrl, imageBase64, imageMimeType, history },
        { onChunk: (delta) => send({ type: "chunk", content: delta }) },
        signal
      );

      // 2) Derive the structured quote card (best-effort, text-only).
      // Only surface a card when the copilot actually produced a complete estimate
      // — if it's asking follow-up questions, no card is shown until it has enough
      // info to price the job.
      const quote = await extractQuote(text, content, signal);
      const quoteReady =
        !!quote &&
        quote.status === "estimate" &&
        quote.lineItems.length > 0 &&
        Number.isFinite(quote.total) &&
        quote.total > 0;
      if (quoteReady) send({ type: "quote", data: quote });

      // Persist the AI message with the quote on metadata.
      const aiMessage = await messageRepository.create({
        conversationId,
        senderType: "AI",
        senderId: null,
        content: text || "(no estimate)",
        contentType: "TEXT",
        metadata: {
          mode: "estimate",
          modelUsed: ESTIMATE_MODEL,
          runId,
          quote: quoteReady ? quote : null,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        },
      });

      send({ type: "done", data: aiMessage });
      clearInterval(heartbeat);
      res.end();

      logger.info("Estimate stream completed", {
        conversationId,
        messageId: aiMessage.id,
        hasQuote: Boolean(quote),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Estimate stream error", { conversationId, error: message });
      if (!res.headersSent) {
        return res.status(500).json({ success: false, error: { status: 500, message } });
      }
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: message })}\n\n`);
        res.end();
      }
    }
  }
}
