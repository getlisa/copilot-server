import { QdrantClient } from "@qdrant/js-client-rest";
import { CohereClient } from "cohere-ai";
import { OpenAI } from "openai";
import { tool } from "@openai/agents";
import { z } from "zod";
import logger from "../../lib/logger";
import { recordRagSources } from "./ragToolSources";

type Trade = "HVAC" | "Plumbing" | "Fire" | "Electrical";

interface TechnicalManualChunk {
  chunk_id: string;
  category: Trade;
  chunk_text: string;
  chunk_type: "text" | "image" | "table";
  // image_s3_urls?: string[];
  file_s3_url: string;
  page_number?: number;
  metadata?: Record<string, unknown>;
}

// This is the structure returned by Qdrant search
interface QdrantSearchResult {
  id: string | number;
  score: number;
  payload: TechnicalManualChunk;
}

// Initialize Clients
const qdrant = new QdrantClient({
  url: process.env.QDRANT_CLUSTER_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});
const cohere = new CohereClient({ token: process.env.COHERE_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const technicalManualTool = tool({
  name: "technical_manual_tool",
  description:
    "Search Qdrant for relevant HVAC/Plumbing/Fire/Electrical manual chunks.",
  // parameters: z
  //   .object({
  //     query: z
  //       .string()
  //       .describe('Detailed technical query that includes the brand, model number for accurate search.'),
  //     // trade: z.enum(["HVAC", "Plumbing", "Fire", "Electrical"]).describe('Determine the trade based on the brand, model, equipment. Example: "I am having this error in my AC system, Indoor-remote controller communication error" -> HVAC'),
  //   }),
  parameters: z
  .object({
    brand: z.string().describe('The brand of the equipment.'),
    model: z.string().describe('The model of the equipment.'),
    issue: z.string().describe('The issue with the equipment.'),
  }),
  async execute(
    { brand, model, issue }: { brand: string; model: string; issue: string },
    runContext?: { context?: { conversationId?: string; userId?: string } }
  ) {
    const contextInfo = {
      conversationId: runContext?.context?.conversationId,
      userId: runContext?.context?.userId,
    };

    const searchQuery = `Brand: ${brand}, Model: ${model}`;
    const completeQuery = `${searchQuery}, Issue: ${issue}`;
    const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL;
    if (!embeddingModel) {
      return { error: "OPENAI_EMBEDDING_MODEL is not set" };
    }

    console.log(`SEARCH QUERY IS: ${searchQuery}`);

    const formatError = (error: unknown) => {
      const errObj = error as any;
      return {
        message: error instanceof Error ? error.message : String(error),
        status: errObj?.status ?? errObj?.response?.status,
        responseData:
          typeof errObj?.response?.data === "string"
            ? errObj.response.data.slice(0, 500)
            : errObj?.response?.data
            ? JSON.stringify(errObj.response.data).slice(0, 500)
            : undefined,
      };
    };

    logger.info("technical_manual_tool invoked", {
      ...contextInfo,
      queryPreview: searchQuery,
      // trade: trade,
    });

    const collection = process.env.QDRANT_COLLECTION_NAME;
    if (!collection || !process.env.QDRANT_CLUSTER_URL) {
      return {
        error: "Qdrant is not configured (missing QDRANT_COLLECTION_NAME or QDRANT_CLUSTER_URL).",
      };
    }
    try {
      // 1) Generate embedding
      let queryVector: number[] | undefined;
      try {
        const embeddingResponse = await openai.embeddings.create({
          model: embeddingModel || "text-embedding-3-small",
          input: searchQuery,
          dimensions: 1536,
        });
        queryVector = embeddingResponse.data?.[0]?.embedding;
      } catch (error) {
        logger.error("technical_manual_tool embedding failed", {
          ...contextInfo,
          ...formatError(error),
        });
        return { error: "Embedding generation failed. Check OpenAI API key/permissions." };
      }

      if (!queryVector) {
        return { error: "Embedding generation returned no vector." };
      }

      // 2) Vector search in Qdrant (filter only when trade provided)
      const filter = undefined;
      // const filter = trade
      //   ? {
      //       must: [{ key: "category", match: { value: trade } }],
      //     }
      //   : undefined;

      let searchResults: QdrantSearchResult[] = [];
      try {
        searchResults = (await qdrant.search(collection, {
          vector: {
            name: "text_embeddings",
            vector: queryVector,
          },
          filter,
          limit: 15,
          with_payload: true,
        })) as unknown as QdrantSearchResult[];
      } catch (error) {
        logger.error("technical_manual_tool Qdrant search failed", {
          ...contextInfo,
          collection,
          filterApplied: Boolean(filter),
          // trade: trade,
          ...formatError(error),
        });
        return { error: "Qdrant search failed. Check QDRANT credentials/permissions." };
      }

      logger.info("Qdrant search complete", {
        ...contextInfo,
        collection,
        hits: searchResults.length,
        // trade: trade || "any",
        topScore: searchResults[0]?.score?.toFixed(3),
      });

      if (!searchResults || searchResults.length === 0) {
        return { results: [], message: "No results found for the given query." };
      }

      // 3) Rerank with Cohere using chunk_text
      const documents = searchResults.map((p) => p.payload?.chunk_text ?? "");
      let reranked: Awaited<ReturnType<typeof cohere.rerank>>;
      try {
        reranked = await cohere.rerank({
          model: "rerank-english-v3.0",
          query: completeQuery,
          documents,
          topN: Math.min(3, documents.length),
        });
      } catch (error) {
        logger.error("technical_manual_tool rerank failed", {
          ...contextInfo,
          ...formatError(error),
        });
        return { error: "Rerank failed. Check Cohere API key/permissions." };
      }

      const relevantRerankedDocuments = [];
      for (let i = 0; i < reranked.results.length; i++) {
        if (reranked.results[i].relevanceScore >= 0.85) {
          relevantRerankedDocuments.push(reranked.results[i]);
        }
      }
      logger.info("RAG rerank complete", {
        ...contextInfo,
        total: reranked.results.length,
        relevant: relevantRerankedDocuments.length,
        topScore: reranked.results[0]?.relevanceScore?.toFixed(3),
      });
      if (relevantRerankedDocuments.length === 0) {
        return { results: [], message: "No relevant results found for the given query. Please try with more specficic query or use another tool." };
      }
      // 4) Map top results back to payloads and include diagram URLs
      const exposeUrlsToModel = process.env.RAG_TOOL_EXPOSE_URLS_TO_MODEL !== "false";
      const runId = (runContext?.context as { runId?: string } | undefined)?.runId;

      const results = await Promise.all(
        relevantRerankedDocuments.map(async (rerankedDocument) => {
          const point = searchResults[rerankedDocument.index];
          // const rawImages = point.payload?.image_s3_urls ?? [];
          const rawFileUrl = point.payload.file_s3_url;
          const pageNumber = point.payload.page_number ?? undefined;
          const pageNumberString = pageNumber ? `Page ${pageNumber}` : undefined;
          // const imageUrls = rawImages.filter(
          //   (url): url is string => typeof url === "string" && url.trim().length > 0
          // );
          const fileUrl =
            typeof rawFileUrl === "string" && rawFileUrl.trim().length > 0
              ? rawFileUrl
              : undefined;

          if (runId && fileUrl) {
            recordRagSources(runId, [
              {
                chunkId: point.payload?.chunk_id,
                fileUrl,
                trade: point.payload?.category,
              },
            ]);
          }
          const documents = [{
            relevance: rerankedDocument.relevanceScore,
            text: point.payload?.chunk_text,
            pageNumber: pageNumberString,
            fileUrl: exposeUrlsToModel ? fileUrl : undefined,
            trade: point.payload?.category,
          }];

          console.log(`DOCUMENTS: ${JSON.stringify(documents, null, 2)}`);

          return documents as any;
        })
      );


      return { results };
    } catch (error) {
      logger.error("technical_manual_tool failed", {
        ...contextInfo,
        error: error instanceof Error ? error.message : String(error),
      });
      return { error: "Technical manual search failed. Please try again." };
    }
  },
});