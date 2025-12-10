import {
  RealtimeAgent,
  RealtimeSession,
  RealtimeSessionConnectOptions,
  RealtimeItem,
  TransportLayerAudio,
} from "@openai/agents/realtime";
import logger from "../lib/logger";
import { voiceSystemPrompt } from "../config/systemPrompt";

export interface RealtimeVoiceOptions {
  onTranscriptionPartial?: (text: string) => void;
  onTranscriptionFinal?: (text: string) => void;
  onAudioOutput?: (audioBase64: string) => void;
  onAssistantText?: (text: string) => void;
  model?: string;
  /**
   * Optional turn detection config; if unset, server VAD with response on silence is used.
   * Example: { type: "server_vad", silenceDurationMs: 400, interruptResponse: true, createResponse: true }
   */
  turnDetection?: Record<string, any>;
  /** Output voice (e.g., "alloy") */
  voice?: string;
  /** Input audio format; defaults to 24k PCM */
  inputFormat?: { type: "audio/pcm"; rate: number } | string;
}

/**
 * Voice session powered by OpenAI Realtime (Agent SDK).
 * Provides STT and TTS via a RealtimeSession (websocket transport in Node).
 */
export class RealtimeVoiceSession {
  private session: RealtimeSession | null = null;
  private agent: RealtimeAgent | null = null;
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
    const inputFormat =
      this.options.inputFormat ?? { type: "audio/pcm", rate: 24000 };
    const turnDetection =
      this.options.turnDetection ??
      {
        type: 'semantic_vad',
        eagerness: 'medium',
        createResponse: true,
        interruptResponse: true
      };
      // {
      //   type: "server_vad",
      //   createResponse: true,
      //   interruptResponse: true,
      //   silenceDurationMs: 400,
      // };

    this.agent = new RealtimeAgent({
      name: "Clara Voice",
      instructions: voiceSystemPrompt,
    });

    this.session = new RealtimeSession(this.agent, {
      transport: "websocket",
      model,
      historyStoreAudio: false,
      config: {
        outputModalities: ["audio", "text"],
        audio: {
          input: {
            format: inputFormat,
            transcription: { model: "gpt-4o-mini-transcribe", language: "en" },
            turnDetection,
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice,
          },
        },
      },
    });

    this.registerSessionHandlers();

    const connectOptions: RealtimeSessionConnectOptions = {
      apiKey,
      model,
    };

    await this.session.connect(connectOptions);
    this.connected = true;
    logger.info("Realtime voice session connected", { model });
  }

  stop(): void {
    if (this.session) {
      this.session.close();
      this.session = null;
    }
    this.connected = false;
    logger.info("Realtime voice session stopped");
  }

  /**
   * Send user text to the session; the model will respond with audio.
   */
  sendText(text: string): void {
    if (!this.session || !this.connected) {
      logger.warn("Cannot sendText: session not connected");
      return;
    }
    this.session.sendMessage({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    });
  }

  /**
   * Send audio (ArrayBuffer) to the session for STT; commit triggers transcription/response.
   */
  sendAudioBase64(audioBase64: string, commit = false): void {
    if (!this.session || !this.connected) {
      logger.warn("sendAudioBase64: session not connected, ignoring audio");
      return;
    }
    const buffer = this.base64ToArrayBuffer(audioBase64);
    logger.debug("Sending audio chunk", { bytes: buffer.byteLength, commit });
    this.session.sendAudio(buffer, { commit });
  }

  /**
   * Send raw audio buffer (PCM) to the session.
   */
  sendAudio(buffer: ArrayBuffer, commit = false): void {
    if (!this.session || !this.connected) return;
    this.session.sendAudio(buffer, { commit });
  }

  private registerSessionHandlers(): void {
    if (!this.session) return;

    // Audio output from the model
    this.session.on("audio", (event: TransportLayerAudio) => {
      if (event?.data && this.options.onAudioOutput) {
        this.options.onAudioOutput(this.arrayBufferToBase64(event.data));
      }
    });

    // History updates for transcripts
    this.session.on("history_added", (item: RealtimeItem) => {
      if (
        item.type === "message" &&
        item.role === "user" &&
        Array.isArray((item as any).content)
      ) {
        const audioContent = (item as any).content.find(
          (c: any) => c?.type === "input_audio" && c?.transcript
        );
        if (audioContent?.transcript && this.options.onTranscriptionFinal) {
          this.options.onTranscriptionFinal(audioContent.transcript as string);
        }
      }

      if (
        item.type === "message" &&
        item.role === "assistant" &&
        Array.isArray((item as any).content)
      ) {
        const textContent = (item as any).content.find(
          (c: any) => c?.type === "output_text" && typeof c?.text === "string"
        );
        if (textContent?.text && this.options.onAssistantText) {
          this.options.onAssistantText(textContent.text as string);
        }
      }
    });

    // Transport events (e.g., partial transcripts, turn detection)
    this.session.on("transport_event", (event: any) => {
      // Log all transport events for debugging turn detection
      logger.debug("Transport event", { type: event?.type });
      
      if (event?.type === "audio_transcript_delta" && this.options.onTranscriptionPartial) {
        this.options.onTranscriptionPartial(event.delta as string);
      }
      
      // Log turn detection events
      if (event?.type === "input_audio_buffer.speech_started") {
        logger.info("Speech started - user is speaking");
      }
      if (event?.type === "input_audio_buffer.speech_stopped") {
        logger.info("Speech stopped - user finished speaking");
      }
      if (event?.type === "response.done") {
        logger.info("Assistant response complete");
      }
    });

    // Transport-level errors
    this.session.on("error", (err) => {
      logger.error("Realtime session error", { error: err });
    });
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = Buffer.from(base64, "base64");
    return binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    return Buffer.from(bytes).toString("base64");
  }
}


