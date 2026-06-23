import { Request, Response } from "express";
import { randomUUID } from "crypto";
import logger from "../../lib/logger";
import { conversationRepository } from "../repositories/conversation.repository";
import { messageRepository } from "../repositories/message.repository";
import { ZERO_USAGE, addUsage, type EstimateTurn, type Usage } from "../../copilot/estimate/estimateService";
import type { EstimateQuote, FollowUpQuestion } from "../../copilot/estimate/estimateQuoteSchema";
import { streamEstimateGraph, ESTIMATE_NODES } from "../../copilot/estimate/graph/graph";
import { buildQuotePdf } from "../../copilot/estimate/pdf/quotePdf";
import { loadQuoteHeader } from "../../copilot/estimate/pdf/quoteHeader";
import { uploadBufferToS3, getPresignedUrlForKey, getObjectBufferFromS3 } from "../../lib/s3";

const PDF_URL_TTL = 60 * 60 * 24; // 24h presigned download links

/** Resolve the uploaded equipment photo to a Buffer for embedding in the PDF. */
async function resolveThumbnail(input: {
  imageBase64?: string;
  imageMimeType?: string;
  imageUrl?: string;
}): Promise<{ buffer: Buffer; mimeType?: string } | null> {
  try {
    if (input.imageBase64) {
      return { buffer: Buffer.from(input.imageBase64, "base64"), mimeType: input.imageMimeType };
    }
    if (input.imageUrl) {
      const res = await fetch(input.imageUrl);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return { buffer: buf, mimeType: res.headers.get("content-type") || undefined };
    }
  } catch {
    /* non-fatal — PDF just renders without a thumbnail */
  }
  return null;
}

/**
 * Decode a customer signature into a Buffer. Accepts a raw base64 string or a data URL
 * from a browser signature pad (e.g. "data:image/png;base64,iVBORw0...").
 */
function decodeSignature(input: string): Buffer | null {
  if (!input || typeof input !== "string") return null;
  const match = input.match(/^data:[^;]+;base64,(.*)$/s);
  const b64 = (match ? match[1] : input).trim();
  try {
    const buffer = Buffer.from(b64, "base64");
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

/**
 * DEMO-ONLY estimate-cost controller.
 *
 * Parallel SSE endpoint that runs the self-contained estimate engine
 * (`src/copilot/estimate/*`). It is independent of the live copilot controller,
 * prompt, and LangGraph workflow.
 *
 * POST /api/v1/copilot/:conversationId/estimate/stream
 *
 * Runs the LangGraph estimate workflow (identify → build_quote | ask_questions) and
 * relays its events as SSE frames:
 *   user_message · thinking · node · identified · message · quote · questions · done · error
 *   - `node`      : graph step lifecycle { node, phase: "start"|"end" } (progress)
 *   - `identified`: the identified equipment (early, from the identify node)
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

      // Run the LangGraph workflow; relay node lifecycle + custom events as SSE.
      const stream = streamEstimateGraph(
        { content, imageUrl, imageBase64, imageMimeType, history },
        signal
      );

      let message = "";
      let quote: EstimateQuote | null = null;
      let questions: FollowUpQuestion[] | null = null;
      let responseKind: "quote" | "questions" | "message" = "message";
      let usage: Usage = ZERO_USAGE;
      const seenNodeFrame = new Set<string>(); // dedup node start/end frames

      for await (const ev of stream) {
        const node = (ev as any).metadata?.langgraph_node as string | undefined;
        const isNodeChain = !!node && ESTIMATE_NODES.has(node) && ev.name === node;

        if ((ev.event === "on_chain_start" || ev.event === "on_chain_end") && isNodeChain) {
          const phase = ev.event === "on_chain_start" ? "start" : "end";
          const key = `${node}:${phase}`;
          if (!seenNodeFrame.has(key)) {
            seenNodeFrame.add(key);
            logger.info(`Estimate node ${phase}`, { conversationId, runId, node });
            send({ type: "node", node, phase });
          }
          continue;
        }

        if (ev.event === "on_custom_event") {
          const data = (ev as any).data;
          switch (ev.name) {
            case "usage":
              usage = addUsage(usage, data as Usage);
              break;
            case "identified":
              logger.info("Estimate event: identified", { conversationId, runId });
              send({ type: "identified", data });
              break;
            case "message":
              message = data?.content ?? "";
              logger.info("Estimate event: message", { conversationId, runId });
              send({ type: "message", content: message });
              break;
            case "quote":
              quote = data as EstimateQuote;
              responseKind = "quote";
              logger.info("Estimate event: quote", { conversationId, runId, total: quote?.total });
              send({ type: "quote", data: quote });
              break;
            case "questions":
              questions = (data?.questions ?? []) as FollowUpQuestion[];
              responseKind = "questions";
              logger.info("Estimate event: questions", { conversationId, runId, count: questions.length });
              send({ type: "questions", data: { questions } });
              break;
          }
        }
      }

      // On a quote turn we do NOT generate the PDF yet — the customer must first
      // confirm the estimate with a digital signature (see `sign`). We assign a stable
      // estimate number now, and stash the uploaded equipment photo in S3 so the signed
      // PDF can re-embed the thumbnail later. Best-effort — failures never break the stream.
      let estimateNumber: string | undefined;
      let equipmentImageKey: string | null = null;
      if (responseKind === "quote" && quote) {
        estimateNumber = `E${Date.now().toString(36).toUpperCase()}`;
        try {
          const thumb = await resolveThumbnail({ imageBase64, imageMimeType, imageUrl });
          if (thumb) {
            const ext = (thumb.mimeType?.split("/")[1] || "jpg").replace("jpeg", "jpg");
            const key = `estimates/${conversationId}/${runId}-equipment.${ext}`;
            await uploadBufferToS3({
              key,
              buffer: thumb.buffer,
              contentType: thumb.mimeType || "image/jpeg",
            });
            equipmentImageKey = key;
          }
        } catch (err) {
          logger.warn("Estimate equipment image stash failed", {
            conversationId,
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Persist the AI message. content = the bubble text; for a questions turn append
      // the questions as text so the next turn's history recalls what was asked.
      const persistedContent =
        responseKind === "questions" && questions
          ? `${message}\n${questionsToText(questions)}`.trim()
          : message || "(no response)";

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
          quote:
            responseKind === "quote" && quote
              ? {
                  ...quote,
                  estimateNumber: estimateNumber ?? null,
                  equipmentImageKey,
                  signed: false,
                  pdfKey: null,
                }
              : null,
          questions: responseKind === "questions" ? questions : null,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        },
      });

      // A quote must be signed by the customer before its PDF is generated.
      send({ type: "done", data: aiMessage, responseKind, requiresSignature: responseKind === "quote" });
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

  /**
   * GET /api/v1/copilot/:conversationId/estimate/:messageId/pdf
   * Re-presign a fresh downloadable URL for a quote's stored PDF and 302-redirect to
   * it (presigned links expire). 404 if the message has no PDF.
   */
  static async downloadPdf(req: Request, res: Response) {
    const { conversationId, messageId } = req.params;
    try {
      const msg = await messageRepository.getById(messageId);
      if (!msg || msg.conversationId !== conversationId) {
        return res.status(404).json({ success: false, error: { status: 404, message: "Quote not found" } });
      }
      const meta = (msg.metadata ?? {}) as any;
      const pdfKey: string | undefined = meta?.quote?.pdfKey;
      if (!pdfKey) {
        return res
          .status(409)
          .json({ success: false, error: { status: 409, message: "Estimate not signed yet — sign it to generate the PDF." } });
      }
      const filename = `Estimate-${meta?.quote?.estimateNumber ?? messageId}.pdf`;
      const url = await getPresignedUrlForKey(pdfKey, PDF_URL_TTL, { downloadFilename: filename });
      return res.redirect(302, url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Estimate PDF download error", { conversationId, messageId, error: message });
      return res.status(500).json({ success: false, error: { status: 500, message } });
    }
  }

  /**
   * POST /api/v1/copilot/:conversationId/estimate/:messageId/sign
   *
   * Confirm a previously-streamed estimate with the customer's digital signature, then
   * generate the FINAL signed quotation PDF (signature embedded), store it in S3, and
   * return a downloadable presigned URL. The quote message metadata is updated with the
   * pdfKey + signed flag so the PDF can be re-downloaded later.
   *
   * Body: { signatureBase64 (raw base64 or data URL), signatureMimeType?, signerName? }
   */
  static async sign(req: Request, res: Response) {
    const { conversationId, messageId } = req.params;
    const signatureBase64: string = req.body?.signatureBase64 ?? "";
    const signatureMimeType: string | undefined = req.body?.signatureMimeType;
    const signerName: string | undefined = req.body?.signerName;

    try {
      const msg = await messageRepository.getById(messageId);
      if (!msg || msg.conversationId !== conversationId) {
        return res.status(404).json({ success: false, error: { status: 404, message: "Quote not found" } });
      }

      const meta = (msg.metadata ?? {}) as any;
      const quote = meta?.quote as
        | (EstimateQuote & { estimateNumber?: string | null; equipmentImageKey?: string | null })
        | null;
      if (meta?.mode !== "estimate" || meta?.responseKind !== "quote" || !quote) {
        return res
          .status(409)
          .json({ success: false, error: { status: 409, message: "This message has no estimate to sign." } });
      }

      const signature = decodeSignature(signatureBase64);
      if (!signature) {
        return res
          .status(400)
          .json({ success: false, error: { status: 400, message: "Invalid or empty signature image." } });
      }

      // Rebuild the PDF inputs: header from the conversation, thumbnail from the stashed photo.
      const conversation = await conversationRepository.getById(conversationId);
      const header = await loadQuoteHeader({
        jobId: conversation?.jobId as any,
        userId: conversation?.userId as any,
      });

      let thumbnail: { buffer: Buffer; mimeType?: string } | undefined;
      if (quote.equipmentImageKey) {
        try {
          thumbnail = { buffer: await getObjectBufferFromS3(quote.equipmentImageKey) };
        } catch {
          /* photo missing/unreadable — PDF just renders without a thumbnail */
        }
      }

      const estimateNumber = quote.estimateNumber || `E${Date.now().toString(36).toUpperCase()}`;
      const signedAt = new Date();
      const buffer = await buildQuotePdf({
        quote: quote as EstimateQuote,
        header,
        estimateNumber,
        date: signedAt,
        thumbnail,
        signature: { buffer: signature, mimeType: signatureMimeType, signerName, signedAt },
      });

      const key = `estimates/${conversationId}/${messageId}.pdf`;
      await uploadBufferToS3({ key, buffer, contentType: "application/pdf" });
      const filename = `Estimate-${estimateNumber}.pdf`;
      const url = await getPresignedUrlForKey(key, PDF_URL_TTL, { downloadFilename: filename });

      // Persist the signed state (merge into existing metadata).
      await messageRepository.update(messageId, {
        metadata: {
          ...meta,
          quote: {
            ...quote,
            estimateNumber,
            pdfKey: key,
            signed: true,
            signedAt: signedAt.toISOString(),
            signerName: signerName ?? null,
          },
        },
      });

      logger.info("Estimate signed + PDF generated", { conversationId, messageId, key });
      return res.json({
        success: true,
        data: { url, key, filename, estimateNumber, signedAt: signedAt.toISOString() },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Estimate sign error", { conversationId, messageId, error: message });
      return res.status(500).json({ success: false, error: { status: 500, message } });
    }
  }
}
