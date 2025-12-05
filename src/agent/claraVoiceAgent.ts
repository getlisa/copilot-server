import { RealtimeVoiceSession, RealtimeVoiceOptions } from "../handler/RealtimeVoiceSession";
import { ClaraAgent, getClaraAgent } from "./ClaraAgent";
import type { AgentContext } from "../types/agent.types";
import logger from "../lib/logger";

/**
 * Voice-first Clara agent: OpenAI Realtime (audio) for STT/TTS + Agent SDK (Clara) for reasoning.
 */
export class ClaraVoiceAgent {
  private clara?: ClaraAgent;
  private voiceSession: RealtimeVoiceSession;
  private context?: AgentContext;

  constructor(options?: RealtimeVoiceOptions) {
    this.voiceSession = new RealtimeVoiceSession({
      ...options,
      onTranscriptionPartial: (text: string) => {
        void this.handleTranscription(text);
      },
      onTranscriptionFinal: (text: string) => {
        void this.handleTranscription(text);
      },
      onAudioOutput: (audioBase64: string) => {
        this.handleAudioOutput(audioBase64);
      },
      onAssistantText: (text: string) => {
        this.handleAssistantText(text);
      },
    });
  }

  async init(): Promise<void> {
    if (!this.clara) {
      this.clara = await getClaraAgent();
    }
  }

  async start(conversationId: string, userId: string): Promise<void> {
    await this.init();
    this.context = { conversationId, userId };
    await this.voiceSession.start();
  }

  stop(): void {
    this.voiceSession.stop();
  }

  /**
   * Push an already-transcribed text to the agent and speak back the answer.
   */
  async sendText(text: string): Promise<void> {
    await this.handleTranscription(text);
  }

  /**
   * Send audio (base64 PCM) to the realtime session for STT/response.
   */
  sendAudioBase64(audioBase64: string, commit = true): void {
    this.voiceSession.sendAudioBase64(audioBase64, commit);
  }

  private async handleTranscription(text: string): Promise<void> {
    if (!text.trim()) return;
    if (!this.clara || !this.context) {
      logger.warn("Voice agent not initialized; ignoring transcription");
      return;
    }

    try {
      const response = await this.clara.processMessage(text, this.context);
      if (response.content) {
        this.voiceSession.sendText(response.content);
      }
    } catch (error) {
      logger.error("Voice agent processing error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleAudioOutput(audioBase64: string): void {
    // Placeholder: hook into playback if needed on the server side
    logger.debug("Audio output received", { bytes: Buffer.from(audioBase64, "base64").length });
  }

  private handleAssistantText(text: string): void {
    // Placeholder: if server needs to react to assistant text (e.g., logging/metrics)
    logger.debug("Assistant text received", { textLength: text.length });
  }
}