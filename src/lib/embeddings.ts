import OpenAI from "openai";
import logger from "./logger";
import { EmbeddingModel } from "openai/resources/embeddings";

const openai = new OpenAI();

/**
 * Generate an embedding for an image buffer using OpenAI embeddings.
 * We encode the image as base64 text and embed it with text-embedding-ada-002 (or model from env).
 * If embedding fails, return null (upload flow continues without embeddings).
 */
export async function generateImageEmbedding(buffer: Buffer): Promise<number[] | null> {
  try {
    const base64 = buffer.toString("base64");
    const resp = await openai.embeddings.create({
      model: process.env.OPENAI_EMBEDDING_MODEL as EmbeddingModel,
      input: base64,
      encoding_format: "float",
      dimensions: 512,
    });

    const embedding = resp.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error("OpenAI embedding response missing embedding array");
    }

    return embedding.map((v) => Number(v));
  } catch (err) {
    logger.warn("Image embedding generation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

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