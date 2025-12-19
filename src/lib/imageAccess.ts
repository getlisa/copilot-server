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