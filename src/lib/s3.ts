import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import dotenv from "dotenv";
dotenv.config();

const region = process.env.AWS_REGION;
const bucket = process.env.AWS_S3_BUCKET;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const configuredTtl = Number(process.env.S3_SIGNED_URL_TTL ?? "900");
const defaultTtl = Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : 900;
const MAX_TTL = 60 * 60 * 24 * 90; // S3 presign hard limit: 90 days

if (!bucket) {
  // We keep this non-fatal to allow local dev without S3, but will throw if used without config.
  console.warn("[s3] S3_BUCKET env var is not set. Uploads will fail until configured.");
}

export const s3Client = new S3Client({
  region,
  credentials: accessKeyId && secretAccessKey
    ? {
        accessKeyId,
        secretAccessKey,
      }
    : undefined,
});

// Normalize keys that may include protocol/bucket prefixes to a bare object key.
function normalizeS3Key(key: string): string {
  if (!key) return key;
  let normalized = key.trim();
  // Strip s3://bucket/
  normalized = normalized.replace(/^s3:\/\/[^/]+\/+/i, "");
  // Strip https://bucket.s3.../
  normalized = normalized.replace(/^https?:\/\/[^/]+\/+/i, "");
  return normalized;
}

export async function uploadBufferToS3(params: {
  key: string;
  buffer: Buffer;
  contentType: string;
}): Promise<{ key: string }> {
  if (!bucket) {
    throw new Error("S3 bucket not configured (S3_BUCKET missing)");
  }
  const key = normalizeS3Key(params.key);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: params.buffer,
      ContentType: params.contentType,
    })
  );

  return { key };
}

/** Download an object's bytes into a Buffer (used to re-embed a stored image in a PDF). */
export async function getObjectBufferFromS3(key: string): Promise<Buffer> {
  if (!bucket) {
    throw new Error("S3 bucket not configured (S3_BUCKET missing)");
  }
  const normalizedKey = normalizeS3Key(key);
  const out = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: normalizedKey }));
  const body = out.Body as unknown as { transformToByteArray?: () => Promise<Uint8Array> };
  if (body?.transformToByteArray) {
    return Buffer.from(await body.transformToByteArray());
  }
  // Fallback: stream → buffer (Node stream)
  const chunks: Buffer[] = [];
  for await (const chunk of out.Body as unknown as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function getPresignedUrlForKey(
  key: string,
  expiresInSeconds: number = defaultTtl,
  opts?: { downloadFilename?: string }
): Promise<string> {
  if (!bucket) {
    throw new Error("S3 bucket not configured (S3_BUCKET missing)");
  }
  const normalizedKey = normalizeS3Key(key);
  const safeTtl =
    !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0
      ? defaultTtl
      : Math.min(expiresInSeconds, MAX_TTL);

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: normalizedKey,
    // When set, browsers/apps download the object (with this filename) instead of
    // rendering it inline.
    ...(opts?.downloadFilename
      ? { ResponseContentDisposition: `attachment; filename="${opts.downloadFilename}"` }
      : {}),
  });

  return getSignedUrl(s3Client, command, { expiresIn: safeTtl });
}

export { normalizeS3Key };