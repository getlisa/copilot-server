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

/**
 * POST /api/v1/copilot/:conversationId/estimate/:messageId/generate
 *
 * Generate the final quotation PDF. Takes no body fields. The deprecated `/sign` alias
 * uses it too — passthrough lets old clients keep posting a signature, which is ignored.
 */
export const estimateGenerateSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("conversationId must be a valid UUID"),
    messageId: z.string().uuid("messageId must be a valid UUID"),
  }),
  body: z.object({}).passthrough(),
  query: z.object({}).passthrough(),
});

/**
 * POST /api/v1/copilot/:conversationId/estimate/:messageId/email
 *
 * Email the generated estimate PDF to the customer. `to` is the confirmed/edited address
 * (suggested from the job when available) or the one the technician typed in.
 */
export const estimateEmailSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("conversationId must be a valid UUID"),
    messageId: z.string().uuid("messageId must be a valid UUID"),
  }),
  body: z.object({
    to: z.string().email("to must be a valid email address"),
  }),
  query: z.object({}).passthrough(),
});
