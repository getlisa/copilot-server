import prisma from "./prisma";
import { getPresignedUrlForKey } from "./s3";

/**
 * Shared image-resolution helpers for the copilot/chat controllers.
 * Extracted from the original ChatController so the unified copilot controller and
 * the legacy chat adapter resolve vision images identically.
 */

export type ResolvedImage = { id: string; url: string; filename?: string; mimeType?: string };
export type InlineImageInput = { data: string; mimeType?: string };

/** Redact presigned URLs for logging (strip query params). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** Parse inline image inputs (data URLs / base64) from the request body. */
export function parseInlineImages(raw: unknown): InlineImageInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item: any) => {
      if (typeof item === "string") {
        return { data: item } satisfies InlineImageInput;
      }
      if (item && typeof item === "object") {
        const data = item.data ?? item.base64 ?? item.url;
        const mimeType = item.mimeType ?? item.type;
        if (typeof data === "string" && data.trim()) {
          return { data, mimeType } satisfies InlineImageInput;
        }
      }
      return null;
    })
    .filter((v): v is InlineImageInput => Boolean(v && typeof v.data === "string"));
}

export function parseDeviceTimezoneHeader(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const trimmed = header.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Pull presigned URLs from a specific IMAGE message's attachments. */
export async function fetchImagesFromMessage(msg: any): Promise<ResolvedImage[]> {
  if (!msg || msg.contentType !== "IMAGE") return [];
  const attArr = Array.isArray(msg.attachments) ? msg.attachments : [];
  const images: ResolvedImage[] = [];
  for (const raw of attArr) {
    const att = raw as Record<string, any>;
    if (att?.url) {
      images.push({ id: att.id ?? msg.id, url: att.url, filename: att.filename, mimeType: att.type });
    } else if (att && att.metadata && att.metadata.s3Key) {
      const url = await getPresignedUrlForKey(att.metadata.s3Key);
      images.push({ id: att.id ?? msg.id, url, filename: att.filename, mimeType: att.type });
    }
  }
  return images;
}

/** Fetch specific images by their ImageFile IDs (within the same conversation). */
export async function fetchImagesByIds(
  conversationId: string,
  imageIds: string[]
): Promise<ResolvedImage[]> {
  if (imageIds.length === 0) return [];
  const files = await prisma.imageFile.findMany({
    where: { conversationId, id: { in: imageIds } },
  });
  if (files.length === 0) return [];
  const urls = await Promise.all(
    files.map((f: { s3Key: string }) => getPresignedUrlForKey(f.s3Key))
  );
  return files.map((f: any, idx: number) => ({
    id: f.id,
    url: urls[idx],
    filename: f.filename ?? undefined,
    mimeType: f.mimeType,
  }));
}
