import { Request, Response } from "express";
import { randomUUID } from "crypto";
import logger from "../../lib/logger";
import { conversationRepository } from "../repositories/conversation.repository";
import { messageRepository } from "../repositories/message.repository";
import { contextService } from "../../copilot/orchestrator/contextService";
import { streamOrchestrator, ORCHESTRATOR_NODES } from "../../copilot/orchestrator/graph/graph";
import { runToCompletion } from "../../copilot/orchestrator/runOrchestrator";
import { ESTIMATE_NODES } from "../../copilot/estimate/graph/graph";
import { ZERO_USAGE, addUsage, type Usage } from "../../copilot/estimate/estimateService";
import type { EstimateQuote, FollowUpQuestion } from "../../copilot/estimate/estimateQuoteSchema";
import type {
  ActionItem,
  CitationItem,
  CopilotBlock,
  CopilotResponse,
  CopilotResponseKind,
  Identification,
  SourceItem,
} from "../../copilot/orchestrator/responseContract";
import {
  fetchImagesByIds,
  fetchImagesFromMessage,
  parseDeviceTimezoneHeader,
  parseInlineImages,
  redactUrl,
  type ResolvedImage,
} from "../../lib/copilotImages";
import { uploadBufferToS3 } from "../../lib/s3";

const GENERAL_MODEL = process.env.OPENAI_AGENT_MODEL || "gpt-5.4-mini";

/** All node names relayed as `node` SSE frames (orchestrator + embedded estimate). */
const NODE_NAMES = new Set<string>([...ORCHESTRATOR_NODES, ...ESTIMATE_NODES]);

const validMode = (m: unknown): "estimate" | "general" | undefined =>
  m === "estimate" || m === "general" ? m : undefined;

/** Render follow-up questions as plain text so model history recalls what was asked. */
function questionsToText(questions: FollowUpQuestion[]): string {
  return questions
    .map((q, i) => {
      const opts = q.options.map((o) => o.label).join(" / ");
      return `${i + 1}. ${q.question}${opts ? ` (${opts})` : ""}`;
    })
    .join("\n");
}

/** Abort the model run if the client disconnects before the response completes. */
function abortSignalForHttpRequest(res: Response): AbortSignal {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

/** Resolve the uploaded equipment photo to a Buffer for the PDF thumbnail stash. */
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

/** Build the estimate-lifecycle CTA buttons for a signed-eligible quote turn. */
function quoteActions(conversationId: string, messageId: string): ActionItem[] {
  const base = `/api/v1/copilot/${conversationId}/estimate/${messageId}`;
  return [
    { id: "preview", label: "Preview estimate", actionType: "preview_estimate", endpoint: `${base}/preview`, method: "GET", style: "secondary" },
    { id: "sign", label: "Sign estimate", actionType: "sign_estimate", endpoint: `${base}/sign`, method: "POST", style: "primary" },
    { id: "email", label: "Email to customer", actionType: "email_estimate", endpoint: `${base}/email`, method: "POST", style: "secondary" },
    { id: "pdf", label: "Download signed PDF", actionType: "download_pdf", endpoint: `${base}/pdf`, method: "GET", style: "secondary" },
  ];
}

/**
 * Unified copilot controller. Runs the LangGraph orchestrator (router → general |
 * estimate) and relays its `streamEvents` (v2) as NAMED SSE frames, then persists
 * the AI message and emits a terminal `done` carrying the full typed-block envelope.
 */
export class CopilotController {
  /** POST /api/v1/copilot/:conversationId/stream */
  static async stream(req: Request, res: Response) {
    const { conversationId } = req.params;
    const content: string = req.body?.content ?? "";
    const senderId = req.body?.senderId;
    const modeHint = validMode(req.body?.mode);
    const timezone = parseDeviceTimezoneHeader(req.headers["x-device-timezone"]);

    const flush = () => (res as any).flush?.();

    try {
      const conversation = await conversationRepository.getById(conversationId);
      if (!conversation) {
        return res
          .status(404)
          .json({ success: false, error: { status: 404, message: "Conversation not found" } });
      }

      // ---- Resolve vision images (unified superset) ----
      const inlineImages = parseInlineImages(req.body?.images ?? req.body?.inlineImages).map((i) => i.data);
      const selectedImageIds = Array.isArray(req.body?.selectedImageIds)
        ? (req.body.selectedImageIds as string[]).filter((v) => typeof v === "string" && v.trim())
        : [];
      const bodyImageUrls = Array.isArray(req.body?.imageUrls)
        ? (req.body.imageUrls as string[]).filter((v) => typeof v === "string" && v.trim())
        : [];

      let resolved: ResolvedImage[] = [];
      if (selectedImageIds.length > 0) {
        resolved = await fetchImagesByIds(conversationId, selectedImageIds);
      }
      const imageUrls: string[] = [
        ...inlineImages,
        ...bodyImageUrls,
        ...resolved.map((r) => r.url),
      ];
      // Estimate-bound single-image fields (base64 from inline data URL, else first URL).
      const imageBase64: string | undefined =
        req.body?.imageBase64 ?? undefined;
      const imageMimeType: string | undefined = req.body?.imageMimeType ?? undefined;
      const imageUrl: string | undefined = req.body?.imageUrl ?? imageUrls[0];
      const hasImage = imageUrls.length > 0 || Boolean(imageBase64 || imageUrl);

      if (imageUrls.length > 0) {
        logger.info("Copilot vision context", {
          conversationId,
          imageCount: imageUrls.length,
          urls: imageUrls.map(redactUrl),
        });
      }

      // ---- Persist the user message ----
      const userMessage = await messageRepository.createWithConversationUpdate({
        conversationId,
        senderType: "USER",
        senderId: senderId ?? conversation.userId ?? null,
        content: content || (hasImage ? "[photo]" : ""),
        contentType: hasImage ? "IMAGE" : "TEXT",
        metadata: { mode: modeHint ?? "auto", hasImage },
      });

      // ---- SSE setup (named events) ----
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
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

      // ---- Build context + run the orchestrator ----
      const { systemContext, history } = await contextService.build(conversationId, timezone);
      const signal = abortSignalForHttpRequest(res);
      const runId = randomUUID();

      const stream = streamOrchestrator(
        {
          conversationId,
          userId: String(senderId ?? conversation.userId ?? "user"),
          content,
          modeHint,
          timezone,
          imageUrls,
          imageUrl,
          imageBase64,
          imageMimeType,
          systemContext,
          history,
        },
        signal
      );

      // ---- Accumulators (single source of truth for the final envelope) ----
      let route: "estimate" | "general" = modeHint ?? "general";
      let routeReason = "";
      let streamedText = "";
      let bubbleText = "";
      let identification: Identification | null = null;
      let quote: EstimateQuote | null = null;
      let questions: FollowUpQuestion[] = [];
      let citations: CitationItem[] = [];
      let sources: SourceItem[] = [];
      let followUps: { id: string; prompt: string; label: string }[] = [];
      const toolsUsed: string[] = [];
      let responseKind: CopilotResponseKind = "message";
      let usage: Usage = ZERO_USAGE;
      const seenNodeFrame = new Set<string>();

      for await (const ev of stream) {
        const node = (ev as any).metadata?.langgraph_node as string | undefined;
        const isNodeChain = !!node && NODE_NAMES.has(node) && ev.name === node;

        if ((ev.event === "on_chain_start" || ev.event === "on_chain_end") && isNodeChain) {
          const phase = ev.event === "on_chain_start" ? "start" : "end";
          const key = `${node}:${phase}`;
          if (!seenNodeFrame.has(key)) {
            seenNodeFrame.add(key);
            send({ type: "node", node, phase });
          }
          continue;
        }

        if (ev.event === "on_custom_event") {
          const data = (ev as any).data;
          switch (ev.name) {
            case "route":
              route = data?.route ?? route;
              routeReason = data?.reason ?? "";
              send({ type: "routing", route, reason: routeReason, source: data?.source ?? "llm" });
              break;
            case "usage":
              usage = addUsage(usage, data as Usage);
              break;
            case "chunk":
              streamedText += data?.content ?? "";
              send({ type: "chunk", content: data?.content ?? "" });
              break;
            case "tool_call":
              if (data?.tool && !toolsUsed.includes(data.tool)) toolsUsed.push(data.tool);
              send({ type: "tool_call", tool: data?.tool });
              break;
            case "identified":
              identification = data ?? null;
              send({ type: "identified", data });
              break;
            case "message":
              bubbleText = data?.content ?? "";
              send({ type: "message", content: bubbleText });
              break;
            case "quote":
              quote = data as EstimateQuote;
              responseKind = "quote";
              send({ type: "quote", data: quote });
              break;
            case "questions":
              questions = (data?.questions ?? []) as FollowUpQuestion[];
              responseKind = "questions";
              send({ type: "questions", data: { questions } });
              break;
            case "citations":
              citations = (data?.items ?? []) as CitationItem[];
              send({ type: "citations", items: citations });
              break;
            case "sources":
              sources = (data?.items ?? []) as SourceItem[];
              send({ type: "sources", items: sources });
              break;
            case "followUps":
              followUps = data?.items ?? [];
              send({ type: "followUps", items: followUps });
              break;
          }
        }
      }

      const finalText = streamedText || bubbleText;

      // ---- Quote turn: assign number + stash equipment photo (for the signed PDF) ----
      let estimateNumber: string | undefined;
      let equipmentImageKey: string | null = null;
      if (responseKind === "quote" && quote) {
        estimateNumber = `E${Date.now().toString(36).toUpperCase()}`;
        try {
          const thumb = await resolveThumbnail({ imageBase64, imageMimeType, imageUrl });
          if (thumb) {
            const ext = (thumb.mimeType?.split("/")[1] || "jpg").replace("jpeg", "jpg");
            const key = `estimates/${conversationId}/${runId}-equipment.${ext}`;
            await uploadBufferToS3({ key, buffer: thumb.buffer, contentType: thumb.mimeType || "image/jpeg" });
            equipmentImageKey = key;
          }
        } catch (err) {
          logger.warn("Copilot equipment image stash failed", {
            conversationId,
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ---- Persist the AI message ----
      const persistedContent =
        responseKind === "questions" && questions.length
          ? `${finalText}\n${questionsToText(questions)}`.trim()
          : finalText || "(no response)";

      const aiMessage = await messageRepository.create({
        conversationId,
        senderType: "AI",
        senderId: null,
        content: persistedContent,
        contentType: "TEXT",
        metadata: {
          mode: route,
          route,
          routeReason,
          responseKind,
          modelUsed: route === "estimate" ? process.env.ESTIMATE_MODEL || "gpt-5.4" : GENERAL_MODEL,
          runId,
          quote:
            responseKind === "quote" && quote
              ? { ...quote, estimateNumber: estimateNumber ?? null, equipmentImageKey, signed: false, pdfKey: null }
              : null,
          questions: responseKind === "questions" ? questions : null,
          toolsUsed,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        },
      });

      // ---- Assemble the final typed-block envelope (now we have messageId) ----
      const blocks: CopilotBlock[] = [];
      if (identification) blocks.push({ kind: "identified", data: identification });
      if (finalText) blocks.push({ kind: "markdown", text: finalText });
      if (citations.length) blocks.push({ kind: "citations", items: citations });
      if (sources.length) blocks.push({ kind: "sources", items: sources });
      if (followUps.length) blocks.push({ kind: "followUps", items: followUps });
      if (responseKind === "quote" && quote) {
        // Surface the estimate number + unsigned state on the card the UI renders.
        blocks.push({ kind: "quote", data: { ...quote, estimateNumber: estimateNumber ?? null, signed: false } });
        blocks.push({ kind: "actions", items: quoteActions(conversationId, aiMessage.id) });
      }
      if (responseKind === "questions" && questions.length) {
        blocks.push({ kind: "questions", data: { questions } });
      }
      const response: CopilotResponse = { responseKind, blocks };

      // Persist the assembled blocks so history re-renders the same rich cards.
      await messageRepository.update(aiMessage.id, {
        metadata: { ...((aiMessage.metadata as any) ?? {}), blocks },
      });

      send({
        type: "done",
        data: aiMessage,
        responseKind,
        requiresSignature: responseKind === "quote",
        response,
      });
      clearInterval(heartbeat);
      res.end();

      logger.info("Copilot stream completed", { conversationId, messageId: aiMessage.id, route, responseKind });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Copilot stream error", { conversationId, error: message });
      if (!res.headersSent) {
        return res.status(500).json({ success: false, error: { status: 500, message } });
      }
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: message })}\n\n`);
        res.end();
      }
    }
  }

  /** POST /api/v1/copilot/:conversationId/send — non-streaming. */
  static async send(req: Request, res: Response) {
    const { conversationId } = req.params;
    const content: string = req.body?.content ?? "";
    const senderId = req.body?.senderId;
    const modeHint = validMode(req.body?.mode);
    const timezone = parseDeviceTimezoneHeader(req.headers["x-device-timezone"]);

    try {
      const conversation = await conversationRepository.getById(conversationId);
      if (!conversation) {
        return res.status(404).json({ success: false, error: { status: 404, message: "Conversation not found" } });
      }

      const inlineImages = parseInlineImages(req.body?.images ?? req.body?.inlineImages).map((i) => i.data);
      const bodyImageUrls = Array.isArray(req.body?.imageUrls)
        ? (req.body.imageUrls as string[]).filter((v) => typeof v === "string" && v.trim())
        : [];
      const selectedImageIds = Array.isArray(req.body?.selectedImageIds)
        ? (req.body.selectedImageIds as string[]).filter((v) => typeof v === "string" && v.trim())
        : [];
      const resolved = selectedImageIds.length > 0 ? await fetchImagesByIds(conversationId, selectedImageIds) : [];
      const imageUrls = [...inlineImages, ...bodyImageUrls, ...resolved.map((r) => r.url)];
      const hasImage = imageUrls.length > 0;

      const userMessage = await messageRepository.createWithConversationUpdate({
        conversationId,
        senderType: "USER",
        senderId: senderId ?? conversation.userId ?? null,
        content: content || (hasImage ? "[photo]" : ""),
        contentType: hasImage ? "IMAGE" : "TEXT",
        metadata: { mode: modeHint ?? "auto", hasImage },
      });

      const result = await runToCompletion({
        conversationId,
        userId: String(senderId ?? conversation.userId ?? "user"),
        content,
        modeHint,
        timezone,
        imageUrls,
        imageUrl: req.body?.imageUrl ?? imageUrls[0],
        imageBase64: req.body?.imageBase64,
        imageMimeType: req.body?.imageMimeType,
      });

      const aiMessage = await messageRepository.create({
        conversationId,
        senderType: "AI",
        senderId: null,
        content: result.content || "(no response)",
        contentType: "TEXT",
        metadata: {
          mode: result.route,
          route: result.route,
          routeReason: result.routeReason,
          responseKind: result.responseKind,
          blocks: result.blocks,
          quote: result.quote,
          questions: result.questions,
          toolsUsed: result.toolsUsed,
          promptTokens: result.usage?.promptTokens,
          completionTokens: result.usage?.completionTokens,
          totalTokens: result.usage?.totalTokens,
        },
      });

      return res.json({
        success: true,
        data: { userMessage, aiMessage, response: { responseKind: result.responseKind, blocks: result.blocks } },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Copilot send error", { conversationId, error: message });
      return res.status(500).json({ success: false, error: { status: 500, message } });
    }
  }
}
