// types/agent.types.ts

/**
 * Callback interface for streaming updates from the agent
 */
export interface AgentStreamCallbacks {
  /** Called when a text chunk is received during streaming */
  onTextChunk?: (chunk: string, fullText: string) => void;
  /** Called when the AI starts thinking/processing */
  onThinking?: () => void;
  /** Called when tool calls are being executed */
  onToolCall?: (toolName: string) => void;
  /** Called when the response is complete */
  onComplete?: (response: AgentResponse) => void;
  /** Called on error */
  onError?: (error: Error) => void;
}

/**
 * Response from the agent
 */
export interface AgentResponse {
  messageId: string;
  content: string;
  metadata?: {
    model?: string;
    tokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    toolsUsed?: string[];
    durationMs?: number;
  };
}

/**
 * Message in conversation history
 */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Context for the agent session
 */
export interface AgentContext {
  conversationId: string;
  userId: string;
  jobId?: string;
  conversationHistory?: ConversationMessage[];
}

/**
 * Main AI Agent interface
 */
export interface AIAgent {
  /** Initialize the agent (creates OpenAI assistant, thread, etc.) */
  init(): Promise<void>;
  
  /** Process a text message with images and return AI response */
  processMessageWithImages(
    text: string,
    images: string[],
    context: AgentContext,
    callbacks?: AgentStreamCallbacks
  ): Promise<AgentResponse>;

  /** Process a text message and return AI response */
  processMessage(text: string, context: AgentContext, callbacks?: AgentStreamCallbacks): Promise<AgentResponse>;
  
  /** Clean up resources */
  dispose(): Promise<void>;
  
  /** Get last interaction timestamp */
  getLastInteraction(): number;
}

/**
 * Voice session interface for TTS/STT
 */
