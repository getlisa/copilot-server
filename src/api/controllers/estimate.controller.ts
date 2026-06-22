import { Request, Response } from "express";
import { randomUUID } from "crypto";
import logger from "../../lib/logger";
import { conversationRepository } from "../repositories/conversation.repository";
import { messageRepository } from "../repositories/message.repository";
import {
  generateEstimate,
  type EstimateTurn,
} from "../../copilot/estimate/estimateService";
import type { FollowUpQuestion } from "../../copilot/estimate/estimateQuoteSchema";

/**
 * DEMO-ONLY estimate-cost controller.
 *
 * Parallel SSE endpoint that runs the self-contained estimate engine
 * (`src/copilot/estimate/*`). It is independent of the live copilot controller,
 * prompt, and LangGraph workflow.
 *
 * POST /api/v1/copilot/:conversationId/estimate/stream
 * SSE frames: user_message · thinking · message · quote · questions · done · error
 *   - `message`   : the chat-bubble text to RENDER
 *   - `quote`     : structured quote to FORMAT as a card
 *   - `questions` : structured follow-ups to FORMAT as option buttons
 *   - `done`      : carries `responseKind` ("quote" | "questions" | "message")
 */

/** Render follow-up questions as plain text so model history recalls what was asked. */
function questionsToText(questions: FollowUpQuestion[]): string {
  return questions
    .map((q, i) => {
      const opts = q.options.map((o) => o.label).join(" / ");
      return `${i + 1}. ${q.question}${opts ? ` (${opts})` : ""}`;
    })
    .join("\n");
}

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

      // Single structured call: the model returns the typed result (message +
      // exactly one of quote / questions). No separate markdown stream, so the UI
      // never receives the estimate twice.
      const { result, usage } = await generateEstimate(
        { content, imageUrl, imageBase64, imageMimeType, history },
        signal
      );

      // Decide what to render. Trust responseKind but validate the quote so the UI
      // never gets an empty card; downgrade to a plain message if neither holds.
      const quoteValid =
        result.quote.status === "estimate" &&
        result.quote.lineItems.length > 0 &&
        Number.isFinite(result.quote.total) &&
        result.quote.total > 0;
      const hasQuestions = result.questions.length > 0;

      let responseKind: "quote" | "questions" | "message";
      if (result.responseKind === "quote" && quoteValid) responseKind = "quote";
      else if (result.responseKind === "questions" && hasQuestions) responseKind = "questions";
      else responseKind = "message";

      // 1) The chat-bubble text (render).
      send({ type: "message", content: result.message });

      // 2) The formatted payload (card or option buttons).
      if (responseKind === "quote") send({ type: "quote", data: result.quote });
      else if (responseKind === "questions") send({ type: "questions", data: { questions: result.questions } });

      // Persist the AI message. content = the bubble text; for a questions turn append
      // the questions as text so the next turn's history recalls what was asked.
      const persistedContent =
        responseKind === "questions"
          ? `${result.message}\n${questionsToText(result.questions)}`.trim()
          : result.message || "(no response)";

      const aiMessage = await messageRepository.create({
        conversationId,
        senderType: "AI",
        senderId: null,
        content: persistedContent,
        contentType: "TEXT",
        metadata: {
          mode: "estimate",
          responseKind,
          modelUsed: ESTIMATE_MODEL,
          runId,
          quote: responseKind === "quote" ? result.quote : null,
          questions: responseKind === "questions" ? result.questions : null,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        },
      });

      send({ type: "done", data: aiMessage, responseKind });
      clearInterval(heartbeat);
      res.end();

      logger.info("Estimate stream completed", {
        conversationId,
        messageId: aiMessage.id,
        responseKind,
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
