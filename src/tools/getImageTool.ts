import { tool } from "@openai/agents";
import { z } from "zod";
import { getRecentImagesWithPresignedUrls } from "../lib/imageAccess";
import { getPresignedUrlForKey } from "../lib/s3";
import prisma from "../lib/prisma";
import logger from "../lib/logger";

/**
 * Tool: get_images
 * Fetches recent images (presigned URLs) for a conversation so the agent
 * can reference previously uploaded equipment photos.
 */
export const getImageTool = tool({
  name: "get_images",
  description:
    "Fetch recent images for a conversation. Useful when the user refers to 'the above images' or previously uploaded equipment photos.",
  parameters: z.object({
    conversationId: z.string().uuid("conversationId must be a UUID"),
  }),
  async execute({ conversationId }) {
    try {
      logger.info("get_images tool invoked", { conversationId });

      // First attempt: ImageFile table
      const primary = await getRecentImagesWithPresignedUrls({
        conversationId,
      });

      let images =
        primary.length > 0
          ? primary.map((img) => ({
              id: img.id,
              url: img.url,
              filename: img.filename ?? undefined,
              mimeType: img.mimeType,
              uploadedAt: img.createdAt,
            }))
          : [];

      // Fallback: pull recent IMAGE messages with attachments if ImageFile is empty
      if (images.length === 0) {
        const fallbackMessages = await prisma.message.findMany({
          where: { conversationId, contentType: "IMAGE" },
          orderBy: { createdAt: "desc" },
          take: 4,
          select: { id: true, attachments: true, createdAt: true },
        });

        for (const msg of fallbackMessages) {
          const attArr = Array.isArray(msg.attachments) ? msg.attachments : [];
          for (const raw of attArr) {
            const att = raw as Record<string, any>;
            const s3Key = att?.metadata?.s3Key;
            try {
              if (s3Key) {
                // Always re-sign when we have the s3Key to avoid expired URLs
                const url = await getPresignedUrlForKey(s3Key);
                images.push({
                  id: att.id ?? msg.id,
                  url,
                  filename: att.filename,
                  mimeType: att.type,
                  uploadedAt: msg.createdAt,
                });
              } else if (att?.url) {
                // Fallback to existing URL if no key to re-sign
                images.push({
                  id: att.id ?? msg.id,
                  url: att.url,
                  filename: att.filename,
                  mimeType: att.type,
                  uploadedAt: msg.createdAt,
                });
              }
            } catch (err) {
              logger.warn("get_images tool failed to re-sign attachment", {
                conversationId,
                attachmentId: att?.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        images = images as { id: string; url: string; filename: string | undefined; mimeType: string; uploadedAt: Date }[];
      }

      logger.info("get_images tool fetched images", {
        conversationId,
        count: images.length,
        urls: images.map((img) => {
          try {
            const u = new URL(img.url);
            return `${u.origin}${u.pathname}`;
          } catch {
            return img.url;
          }
        }),
        urlsSample: images.map((img) => img.url),
      });

      if (images.length === 0) {
        return {
          message: "No images found for this conversation.",
          images: [],
        };
      }

      return {
        message: `Fetched ${images.length} image(s).`,
        images,
      };
    } catch (error) {
      logger.error("get_images tool failed", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        message:
          "Failed to fetch images for this conversation. Please try again or upload the images again.",
        images: [],
      };
    }
  },
});

export default getImageTool;

