import OpenAI from "openai";
import logger from "./logger";
import { EmbeddingModel } from "openai/resources/embeddings";

const openai = new OpenAI();

/**
 * Generate an embedding for text using OpenAI embeddings.
 * If embedding fails, return null so callers can fallback.
 */
export async function generateTextEmbedding(text: string): Promise<number[] | null> {
  const trimmed = text?.trim();
  if (!trimmed) return null;

  try {
    const resp = await openai.embeddings.create({
      model: process.env.OPENAI_EMBEDDING_MODEL as EmbeddingModel,
      input: trimmed,
      encoding_format: "float",
      dimensions: 512,
    });

    const embedding = resp.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error("OpenAI text embedding response missing embedding array");
    }

    return embedding.map((v) => Number(v));
  } catch (err) {
    logger.warn("Text embedding generation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}