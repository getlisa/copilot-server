import { Request, Response } from "express";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { RealtimeVoiceSession } from "../../handler/RealtimeVoiceSession";
import logger from "../../lib/logger";

type VoiceSessionState = {
  session: RealtimeVoiceSession;
  emitter: EventEmitter;
};

/**
 * In-memory voice session store.
 * Note: replace with persistent/session-aware storage if needed for scale.
 */
const voiceSessions = new Map<string, VoiceSessionState>();

export class VoiceController {
  /**
   * Start a new voice session
   * Body: { conversationId: string, userId: string }
   */
  static async start(req: Request, res: Response) {
    try {
      const { conversationId, userId } = req.body as {
        conversationId?: string;
        userId?: string;
      };

      if (!conversationId || !userId) {
        return res.status(400).json({ error: "conversationId and userId are required" });
      }

      const sessionId = randomUUID();
      const emitter = new EventEmitter();

      const session = new RealtimeVoiceSession({
        onTranscriptionPartial: (text: string) => {
          emitter.emit("transcript_partial", { text });
        },
        onTranscriptionFinal: (text: string) => {
          emitter.emit("transcript_final", { text });
        },
        onAudioOutput: (audioBase64: string) => {
          emitter.emit("audio", { audio: audioBase64 });
        },
        onAssistantText: (text: string) => {
          emitter.emit("assistant_text", { text });
        },
      });

      await session.start();

      voiceSessions.set(sessionId, { session, emitter });

      logger.info("Voice session started", { sessionId, conversationId, userId });
      return res.status(200).json({ sessionId });
    } catch (error) {
      logger.error("Voice session start error", { error });
      return res.status(500).json({ error: "Failed to start voice session" });
    }
  }

  /**
   * Send audio chunk (base64 PCM) to the voice session
   * Body: { sessionId: string, audioBase64: string, commit?: boolean }
   */
  static async sendAudio(req: Request, res: Response) {
    try {
      const { sessionId, audioBase64, commit } = req.body as {
        sessionId?: string;
        audioBase64?: string;
        commit?: boolean;
      };

      if (!sessionId || !audioBase64) {
        return res.status(400).json({ error: "sessionId and audioBase64 are required" });
      }

      const state = voiceSessions.get(sessionId);
      if (!state) {
        return res.status(404).json({ error: "Voice session not found" });
      }

      state.session.sendAudioBase64(audioBase64, commit ?? false);
      return res.status(200).json({ ok: true });
    } catch (error) {
      logger.error("Voice sendAudio error", { error });
      return res.status(500).json({ error: "Failed to send audio" });
    }
  }

  /**
   * Stream SSE events for a voice session
   * Query: ?sessionId=...
   */
  static async stream(req: Request, res: Response) {
    const sessionId = req.query.sessionId as string | undefined;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    const state = voiceSessions.get(sessionId);
    if (!state) {
      return res.status(404).json({ error: "Voice session not found" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const onPartial = (payload: any) => send("transcript_partial", payload);
    const onFinal = (payload: any) => send("transcript_final", payload);
    const onAudio = (payload: any) => send("audio", payload);

    state.emitter.on("transcript_partial", onPartial);
    state.emitter.on("transcript_final", onFinal);
    state.emitter.on("audio", onAudio);

    req.on("close", () => {
      state.emitter.off("transcript_partial", onPartial);
      state.emitter.off("transcript_final", onFinal);
      state.emitter.off("audio", onAudio);
    });
  }

  /**
   * Stop and cleanup a voice session
   * Body: { sessionId: string }
   */
  static async stop(req: Request, res: Response) {
    const { sessionId } = req.body as { sessionId?: string };
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    const state = voiceSessions.get(sessionId);
    if (!state) {
      return res.status(404).json({ error: "Voice session not found" });
    }

    state.session.stop();
    voiceSessions.delete(sessionId);
    logger.info("Voice session stopped", { sessionId });
    return res.status(200).json({ ok: true });
  }
}

