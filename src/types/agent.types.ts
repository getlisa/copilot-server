// types/agent.types.ts

export type QueryTheme = "greeting" | "job_context" | "technical_query" | "out_of_scope";
export type TechnicalQueryType = "ambigous" | "incomplete_information" | "complete_information";

export type checklistItem = [
  {
    item_0: "Trade Vertical",
    description: "The trade vertical of the equipment. Example: HVAC, Plumbing, Electrical, or Fire Protection",
  },
  {
    item_1: "Brand",
    description: "The brand of the equipment",
  },
  {
    item_2: "Type",
    description: "The type of the equipment",
  },
  {
    item_4: "Model Number",
    description: "The model number of the equipment",
  }
]

export interface ClassificationResult {
  theme: QueryTheme;
  /** 0.0 – 1.0 */
  confidence: number;
  /** One-sentence summary of why this theme was chosen */
  reasoning: string;
  needsRag: boolean;
  needsWebSearch: boolean;
  needsJobContext: boolean;
}

export interface TechnicalClassificationResult {
  queryType: TechnicalQueryType;
  /** One-sentence summary of why this query type was chosen */
  queryConfidence: number;
  /** 0.0 – 1.0 */
  queryReasoning: string;
  /** The checklist items that are needed to answer the question */
  checklistItems: checklistItem[];
  /** The checklist items that are not needed to answer the question */
  checklistItemsNotNeeded: checklistItem[];
}

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
  /** Called immediately after query classification, before the agent runs */
  onClassification?: (result: ClassificationResult) => void;
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
    sources?: RagSource[];
    diagrams?: string[];
    references?: string[];
    /** Classified state that routed this request */
    state?: QueryTheme;
    /** Classifier confidence score (0–1) */
    classificationConfidence?: number;
    /** Token usage breakdown for the fast classifier call */
    classifierTokens?: { prompt: number; completion: number };
    /** Whether RAG fell back to web search due to low relevance score */
    ragFallbackToWeb?: boolean;
  };
}

export interface RagSource {
  chunkId?: string;
  fileUrl?: string;
  diagrams?: string[];
  trade?: string;
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
  timezone?: string;
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
