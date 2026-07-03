import OpenAI from "openai";
import { OpenAIRealtimeWS } from "openai/realtime/ws";
import logger from "../lib/logger";
import { voiceSystemPrompt } from "../lib/systemPrompt";

export interface RealtimeVoiceOptions {
  onTranscriptionPartial?: (text: string) => void;
  onTranscriptionFinal?: (text: string) => void;
  onAudioOutput?: (audioBase64: string) => void;
  onAssistantText?: (text: string) => void;
  model?: string;
  /**
   * Optional turn detection config; if unset, semantic VAD with response-on-silence
   * is used. Example: { type: "server_vad", silence_duration_ms: 400, interrupt_response: true, create_response: true }
   */
  turnDetection?: Record<string, any> | null;
  /** Output voice (e.g., "alloy") */
  voice?: string;
  /** Input audio format; defaults to 24k PCM (mono, 16-bit, little-endian). */
  inputFormat?: { type: "audio/pcm"; rate?: 24000 } | { type: "audio/pcmu" } | { type: "audio/pcma" };
}

/**
 * Voice session powered by the OpenAI Realtime GA API over a direct WebSocket, using
 * the core `openai` SDK's `OpenAIRealtimeWS` client (no `@openai/agents` dependency).
 * Provides STT and TTS. The public surface (callbacks + methods) is unchanged so the
 * voice controller and ClaraVoiceAgent need no changes.
 */
export class RealtimeVoiceSession {
  private rt: OpenAIRealtimeWS | null = null;
  private connected = false;
  private readonly options: RealtimeVoiceOptions;

  constructor(options: RealtimeVoiceOptions = {}) {
    this.options = options;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.error("Cannot start voice session: OPENAI_API_KEY not set");
      return;
    }

    const model = this.options.model ?? "gpt-realtime";
    const voice = this.options.voice ?? "alloy";
    const inputFormat = this.options.inputFormat ?? { type: "audio/pcm", rate: 24000 };
    const turnDetection =
      this.options.turnDetection ?? {
        type: "semantic_vad",
        eagerness: "medium",
        create_response: true,
        interrupt_response: true,
      };

    const client = new OpenAI({ apiKey });
    const rt = new OpenAIRealtimeWS({ model }, client);
    this.rt = rt;

    this.registerHandlers(rt);

    // Configure the session once the socket is open, then resolve when the server
    // acknowledges with `session.created`/`session.updated`.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Realtime connect timeout")), 15000);

      rt.socket.on("open", () => {
        rt.send({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: voiceSystemPrompt,
            // GA accepts ['text'] OR ['audio'] (not both). Voice → audio; the spoken
            // transcript still arrives via `response.output_audio_transcript.*`.
            output_modalities: ["audio"],
            audio: {
              input: {
                format: inputFormat as any,
                transcription: { model: "gpt-4o-mini-transcribe", language: "en" },
                turn_detection: turnDetection as any,
              },
              output: { format: { type: "audio/pcm", rate: 24000 }, voice },
            },
          },
        });
      });

      rt.on("session.created", () => {
        clearTimeout(timeout);
        this.connected = true;
        logger.info("Realtime voice session connected", { model });
        resolve();
      });

      rt.on("error", (err: any) => {
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err?.error?.message ?? err)));
      });
    });
  }

  stop(): void {
    if (this.rt) {
      try {
        this.rt.close();
      } catch {
        /* socket may already be closed */
      }
      this.rt = null;
    }
    this.connected = false;
    logger.info("Realtime voice session stopped");
  }

  /** Send user text to the session; the model will respond with audio. */
  sendText(text: string): void {
    if (!this.rt || !this.connected) {
      logger.warn("Cannot sendText: session not connected");
      return;
    }
    this.rt.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    this.rt.send({ type: "response.create" });
  }

  /** Send audio (base64 PCM16) to the session; `commit` triggers transcription/response. */
  sendAudioBase64(audioBase64: string, commit = false): void {
    if (!this.rt || !this.connected) {
      logger.warn("sendAudioBase64: session not connected, ignoring audio");
      return;
    }
    this.rt.send({ type: "input_audio_buffer.append", audio: audioBase64 });
    if (commit) this.rt.send({ type: "input_audio_buffer.commit" });
  }

  /** Send a raw PCM16 audio buffer to the session. */
  sendAudio(buffer: ArrayBuffer, commit = false): void {
    if (!this.rt || !this.connected) return;
    this.sendAudioBase64(this.arrayBufferToBase64(buffer), commit);
  }

  private registerHandlers(rt: OpenAIRealtimeWS): void {
    // Model audio output (base64 PCM).
    rt.on("response.output_audio.delta", (event: any) => {
      if (event?.delta && this.options.onAudioOutput) this.options.onAudioOutput(event.delta);
    });

    // User-speech transcription (input audio) — partial + final.
    rt.on("conversation.item.input_audio_transcription.delta", (event: any) => {
      if (event?.delta && this.options.onTranscriptionPartial) {
        this.options.onTranscriptionPartial(event.delta);
      }
    });
    rt.on("conversation.item.input_audio_transcription.completed", (event: any) => {
      if (event?.transcript && this.options.onTranscriptionFinal) {
        this.options.onTranscriptionFinal(event.transcript);
      }
    });

    // Assistant transcript (what the model said) — surface the completed text.
    rt.on("response.output_audio_transcript.done", (event: any) => {
      if (event?.transcript && this.options.onAssistantText) {
        this.options.onAssistantText(event.transcript);
      }
    });
    rt.on("response.output_text.done", (event: any) => {
      if (event?.text && this.options.onAssistantText) this.options.onAssistantText(event.text);
    });

    // Turn-detection diagnostics.
    rt.on("input_audio_buffer.speech_started", () => logger.info("Speech started - user is speaking"));
    rt.on("input_audio_buffer.speech_stopped", () => logger.info("Speech stopped - user finished speaking"));
    rt.on("response.done", () => logger.info("Assistant response complete"));

    rt.on("error", (err: any) => logger.error("Realtime session error", { error: err }));
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    return Buffer.from(new Uint8Array(buffer)).toString("base64");
  }
}
