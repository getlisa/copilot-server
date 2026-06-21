import { z } from "zod";

/**
 * POST /api/v1/copilot/:conversationId/estimate/stream
 *
 * DEMO-ONLY estimate-cost endpoint. Requires at least one of: a text description,
 * an image URL, or a base64 image (so a technician can simply snap a photo).
 */
export const estimateStreamSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("conversationId must be a valid UUID"),
  }),
  body: z
    .object({
      content: z.string().optional(),
      senderId: z.union([z.string(), z.number()]).optional(),
      imageUrl: z.string().url("imageUrl must be a valid URL").optional(),
      imageBase64: z.string().optional(),
      imageMimeType: z.string().optional(),
    })
    .refine(
      (b) => Boolean(b.content?.trim() || b.imageUrl || b.imageBase64),
      { message: "Provide a description (content) and/or an image (imageUrl or imageBase64)." }
    ),
  query: z.object({}).passthrough(),
});
