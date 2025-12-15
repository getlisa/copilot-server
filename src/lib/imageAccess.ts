import { Prisma } from "@prisma/client";
import prisma from "./prisma";
import { getPresignedUrlForKey } from "./s3";

type ImageRecord = {
  id: string;
  messageId: string;
  conversationId: string;
  s3Key: string;
  mimeType: string;
  sizeBytes: bigint | null;
  filename: string | null;
  createdAt: Date;
};

type PresignedImage = {
  id: string;
  messageId: string;
  conversationId: string;
  url: string;
  mimeType: string;
  sizeBytes: bigint | null;
  filename: string | null;
  createdAt: Date;
};

export async function getRecentImagesWithPresignedUrls(options: {
  conversationId: string;
  limit?: number;
  expiresInSeconds?: number;
}): Promise<PresignedImage[]> {
  const limit = options.limit ?? 4;
  const expiresInSeconds = options.expiresInSeconds ?? 900;

  const records: ImageRecord[] = (await prisma.imageFile.findMany({
    where: { conversationId: options.conversationId },
    orderBy: { createdAt: "desc" },
    take: limit,
  })) as unknown as ImageRecord[];

  const presigned = await Promise.all(
    records.map(async (rec) => ({
      id: rec.id,
      messageId: rec.messageId,
      conversationId: rec.conversationId,
      url: await getPresignedUrlForKey(rec.s3Key, expiresInSeconds),
      mimeType: rec.mimeType,
      sizeBytes: rec.sizeBytes,
      filename: rec.filename,
      createdAt: rec.createdAt,
    }))
  );

  return presigned;
}

/**
 * Vector search for images within a conversation using pgvector.
 * Requires the embeddings column (vector) to be populated.
 */
export async function getImagesByEmbeddingWithPresignedUrls(options: {
  conversationId: string;
  embedding: number[];
  limit?: number;
  expiresInSeconds?: number;
}): Promise<PresignedImage[]> {
  const limit = options.limit ?? 4;
  const expiresInSeconds = options.expiresInSeconds ?? 900;
  const embedding = options.embedding;

  if (!Array.isArray(embedding) || embedding.length === 0) {
    return [];
  }

  const vectorLiteral = `[${embedding.join(",")}]`;

  const records = (await prisma.$queryRawUnsafe(
    `
    SELECT
      id,
      message_id   AS "messageId",
      conversation_id AS "conversationId",
      s3_key       AS "s3Key",
      mime_type    AS "mimeType",
      size_bytes   AS "sizeBytes",
      filename,
      created_at   AS "createdAt"
    FROM image_files
    WHERE conversation_id = $1
      AND embeddings IS NOT NULL
    ORDER BY embeddings <=> $2::vector
    LIMIT $3
    `,
    options.conversationId,
    vectorLiteral,
    limit
  )) as unknown as ImageRecord[];

  if (records.length === 0) {
    return [];
  }

  const presigned = await Promise.all(
    records.map(async (rec) => ({
      id: rec.id,
      messageId: rec.messageId,
      conversationId: rec.conversationId,
      url: await getPresignedUrlForKey(rec.s3Key, expiresInSeconds),
      mimeType: rec.mimeType,
      sizeBytes: rec.sizeBytes,
      filename: rec.filename,
      createdAt: rec.createdAt,
    }))
  );

  return presigned;
}