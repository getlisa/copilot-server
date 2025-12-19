import { encoding_for_model, get_encoding, TiktokenModel } from "@dqbd/tiktoken";
import { AgentInputItem } from "@openai/agents";
import dotenv from "dotenv";

dotenv.config();

const FALLBACK_MODEL = "cl100k_base";

/**
 * Estimate tokens for an array of text segments using the requested model if available,
 * otherwise fall back to a baseline encoding.
 */
function countTokens(texts: string[], model: string): number {
  let enc;
  try {
    enc = encoding_for_model(model as TiktokenModel);
  } catch {
    enc = get_encoding(FALLBACK_MODEL);
  }

  try {
    return texts.reduce((sum, t) => sum + enc.encode(t).length, 0);
  } finally {
    enc.free();
  }
}

/**
 * Flatten AgentInputItem-like content blocks to text and count approximate tokens.
 * Non-text content (images, audio, etc.) is ignored for token estimation.
 */
export function countTokensForMessages(
  messages: AgentInputItem[],
  model: string
): number {
  const segments: string[] = [];

  for (const msg of messages ?? []) {
    const content = (msg as any)?.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === "input_text" || item?.type === "output_text") {
          if (typeof item.text === "string") {
            segments.push(item.text);
          }
        }
      }
    }
  }

  if (segments.length === 0) return 0;
  return countTokens(segments, model);
}
