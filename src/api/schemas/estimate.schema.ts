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
 * POST /api/v1/copilot/:conversationId/estimate/:messageId/sign
 *
 * Confirm an estimate with the customer's digital signature. `signatureBase64` may be a
 * raw base64 string or a data URL (e.g. "data:image/png;base64,...") from a signature pad.
 */
export const estimateSignSchema = z.object({
  params: z.object({
    conversationId: z.string().uuid("conversationId must be a valid UUID"),
    messageId: z.string().uuid("messageId must be a valid UUID"),
  }),
  body: z.object({
    signatureBase64: z.string().min(1, "signatureBase64 is required"),
    signatureMimeType: z.string().optional(),
    signerName: z.string().optional(),
  }),
  query: z.object({}).passthrough(),
});

/**
 * POST /api/v1/copilot/:conversationId/estimate/:messageId/email
 *
 * Email the signed estimate PDF to the customer. `to` is the confirmed/edited address
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
