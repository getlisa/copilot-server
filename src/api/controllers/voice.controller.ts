import { Request, Response } from "express";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { RealtimeVoiceSession } from "../../handler/RealtimeVoiceSession";
import logger from "../../lib/logger";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const openai = new OpenAI();

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
    // Hint proxies/CDNs not to buffer SSE
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const flush = () => {
      (res as any).flush?.();
    };

    // Heartbeat to keep idle connections alive behind proxies
    const heartbeat = setInterval(() => {
      res.write(":\n\n");
      flush();
    }, 25000);

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      flush();
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
      clearInterval(heartbeat);
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

  /**
   * One-shot transcription for mic recordings.
   * Body: { audioBase64: string, mimeType?: string, language?: string }
   */
  static async transcribe(req: Request, res: Response) {
    const { audioBase64, mimeType, language } = req.body as {
      audioBase64?: string;
      mimeType?: string;
      language?: string;
    };

    if (!audioBase64) {
      return res.status(400).json({ error: "audioBase64 is required" });
    }

    try {
      const buffer = Buffer.from(audioBase64, "base64");
      const defaultMimeType = "audio/webm";
      const actualMimeType = mimeType ?? defaultMimeType;
      
      // Map mime types to file extensions (OpenAI supports: mp3, mp4, mpeg, mpga, m4a, wav, webm)
      const mimeToExt: Record<string, string> = {
        "audio/webm": "webm",
        "audio/m4a": "m4a",
        "audio/x-m4a": "m4a",
        "audio/mp4": "m4a", // mp4 audio files typically use .m4a extension
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/mpga": "mp3",
        "audio/wav": "wav",
        "audio/wave": "wav",
        "audio/x-wav": "wav",
        "audio/ogg": "ogg",
        "audio/opus": "opus",
      };
      
      // Normalize mimeType for OpenAI (some formats need specific mimeTypes)
      const normalizedMimeType: Record<string, string> = {
        "audio/m4a": "audio/m4a",
        "audio/x-m4a": "audio/m4a",
        "audio/mp4": "audio/m4a", // mp4 audio should be treated as m4a
        "audio/mpeg": "audio/mpeg",
        "audio/mp3": "audio/mpeg",
        "audio/mpga": "audio/mpeg",
        "audio/wav": "audio/wav",
        "audio/wave": "audio/wav",
        "audio/x-wav": "audio/wav",
        "audio/webm": "audio/webm",
        "audio/ogg": "audio/ogg",
        "audio/opus": "audio/opus",
      };
      
      const ext = mimeToExt[actualMimeType] ?? mimeToExt[defaultMimeType];
      const filename = `audio.${ext}`;
      const normalizedType = normalizedMimeType[actualMimeType] ?? actualMimeType;
      
      logger.debug("Transcribing audio", {
        mimeType: actualMimeType,
        normalizedMimeType: normalizedType,
        filename,
        bufferSize: buffer.length,
      });
      
      const file = await toFile(buffer, filename, {
        type: normalizedType,
      });

      const resp = await openai.audio.transcriptions.create(
        {
          file,
          model: "gpt-4o-mini-transcribe",
          language,
        },
        { maxRetries: 2 }
      );

      const text = (resp as any)?.text ?? "";
      return res.status(200).json({
        success: true,
        text,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorDetails = error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : { error: String(error) };
      
      logger.error("Transcription failed", {
        error: errorMessage,
        ...errorDetails,
        mimeType,
        bufferSize: audioBase64 ? Buffer.from(audioBase64, "base64").length : 0,
      });
      
      // Return more specific error message if available
      const statusCode = (error as any)?.status ?? 500;
      const apiError = (error as any)?.error;
      return res.status(statusCode).json({ 
        error: apiError?.message ?? errorMessage ?? "Failed to transcribe audio" 
      });
    }
  }

  /**
   * Body: { text: string, voice?: string }
   * Uses gpt-4o-mini-tts and returns audio/mpeg binary.
   */
  static async tts(req: Request, res: Response) {
    const { text, voice } = req.body as { text?: string; voice?: string };

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }

    try {
      const resp = await openai.audio.speech.create(
        {
          model: "gpt-4o-mini-tts",
          instructions: `
          You're an helpful speaking assistant.
          Keep your tone friendly, professional, and helpful.
          Read all the units as complete words and not as abbreviations.
          Do not speak the links that are provided in the text, links like starting with https://, http://, www. etc. and ending with .com, .org, .net, .io, .etc.
          `,
          voice: voice ?? "alloy",
          input: text,
        },
        { maxRetries: 2 }
      );

      const audioBuffer = Buffer.from(await resp.arrayBuffer());

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", audioBuffer.length);
      return res.status(200).send(audioBuffer);
    } catch (error) {
      logger.error("TTS failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(500).json({ error: "Failed to generate speech" });
    }
  }
}

