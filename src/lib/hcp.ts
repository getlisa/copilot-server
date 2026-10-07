import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { HcpConnection } from "@prisma/client";
import prisma from "./prisma";
import logger from "./logger";

/**
 * Housecall Pro connection + HTTP client — the zt.ts / servicetrade.ts shape, minus the login.
 *
 * Housecall Pro (api.housecallpro.com, home-services field service) is a plain JSON REST API.
 * Auth for a Pro's own integration is a static API key the admin generates in the app, sent as
 * `Authorization: Token <key>` (their docs: the word "Token" is mandatory). No OAuth for
 * non-partners, no expiry, no refresh — a 401 means the key was revoked and the admin must paste
 * a new one. Lists are paged with page / page_size and answer total_pages (or
 * total_pages_count on the price-book endpoints); money is integer CENTS; timestamps ISO-8601.
 * Source: docs.housecallpro.com (Stoplight project "housecall-public-api").
 */

const HCP_API_URL = (process.env.HCP_API_URL ?? "https://api.housecallpro.com").replace(/\/$/, "");

/** Server-level readiness: a sealing key must exist before any API key is accepted. */
export const isHcpConfigured = () => Boolean(process.env.HCP_TOKEN_KEY || process.env.QBO_TOKEN_KEY);

// ---------- encryption at rest (qbo.ts / zt.ts discipline, "hcp:" key domain) ----------

const key = () => {
  const secret = process.env.HCP_TOKEN_KEY || process.env.QBO_TOKEN_KEY;
  if (!secret)
    throw new Error("No sealing key — set QBO_TOKEN_KEY (shared) or HCP_TOKEN_KEY; Housecall Pro API keys are never stored unencrypted");
  return createHash("sha256").update(`hcp:${secret}`).digest();
};

function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

function unseal(sealed: string): string {
  const buf = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

const apiKeyOf = (conn: HcpConnection): string => {
  if (!conn.encryptedAuth) throw new Error("Housecall Pro connection has no stored API key");
  return (JSON.parse(unseal(conn.encryptedAuth)) as { apiKey: string }).apiKey;
};

// ---------- connection ----------

export const hcpConnectionFor = (companyId: number) => prisma.hcpConnection.findUnique({ where: { companyId } });

export const hcpConnected = (conn: HcpConnection | null): conn is HcpConnection => !!conn?.encryptedAuth;

export const disconnectHcp = (companyId: number) => prisma.hcpConnection.deleteMany({ where: { companyId } });

// ---------- HTTP ----------

export class HcpApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

const errorText = (body: unknown): string => {
  const b = body as { message?: unknown; error?: unknown; errors?: unknown } | null;
  const parts = [b?.message, b?.error, b?.errors].flatMap((v) =>
    typeof v === "string" ? [v] : Array.isArray(v) ? v.map(String) : v && typeof v === "object" ? [JSON.stringify(v)] : []
  );
  return parts.join("; ").slice(0, 300);
};

/**
 * One Housecall Pro call with a raw key — the primitive connect() needs before a row exists.
 * 30s deadline, bounded retry ×3 on 5xx/429/network (honouring Retry-After), never on other
 * 4xx. Returns the parsed JSON (null on 202/204 without a body).
 */
export async function hcpFetchWithKey<T = Record<string, unknown>>(
  apiKey: string,
  path: string,
  init?: { method?: string; body?: unknown; form?: FormData }
): Promise<T | null> {
  let lastErr: Error = new Error("Housecall Pro request failed");
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${HCP_API_URL}/${path.replace(/^\//, "")}`, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Token ${apiKey}`,
          Accept: "application/json",
          ...(init?.body != null ? { "Content-Type": "application/json" } : {}),
        },
        body: init?.form ?? (init?.body != null ? JSON.stringify(init.body) : undefined),
        signal: AbortSignal.timeout(init?.form ? 60_000 : 30_000),
      });
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await new Promise((r) =>
        setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 500 * 2 ** attempt)
      );
      lastErr = new HcpApiError(`Housecall Pro returned ${res.status} on ${path.split("?")[0]}`, res.status);
      continue;
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (res.status === 401)
      throw new HcpApiError("Housecall Pro rejected the API key — generate a new one in Housecall Pro and reconnect", 401);
    if (!res.ok) {
      const detail = errorText(body);
      throw new HcpApiError(`Housecall Pro returned ${res.status} on ${path.split("?")[0]}${detail ? `: ${detail}` : ""}`, res.status);
    }
    return (body as T) ?? null;
  }
  throw lastErr;
}

/** The same call against a stored connection. `path` is relative to the API root ("jobs?page=1"). */
export const hcpFetch = <T = Record<string, unknown>>(
  conn: HcpConnection,
  path: string,
  init?: { method?: string; body?: unknown; form?: FormData }
) => hcpFetchWithKey<T>(apiKeyOf(conn), path, init);

/** Walk a paged list (page=n, total_pages | total_pages_count); onPage returns false to stop early. */
export async function hcpPageAll<T extends { total_pages?: number; total_pages_count?: number }>(
  conn: HcpConnection,
  path: string,
  onPage: (data: T) => Promise<boolean | void>,
  maxPages = 200
): Promise<void> {
  for (let page = 1; page <= maxPages; page++) {
    const data = await hcpFetch<T>(conn, `${path}${path.includes("?") ? "&" : "?"}page=${page}`);
    if (!data) return;
    if ((await onPage(data)) === false) return;
    const total = Number(data.total_pages ?? data.total_pages_count ?? 1);
    if (!Number.isFinite(total) || page >= total) return;
  }
}

// ---------- connect ----------

interface HcpCompany {
  id?: string;
  name?: string;
}

/** Connect: validate the key with GET /company (which also names the account), then store sealed. */
export async function connectHcp(companyId: number, apiKey: string): Promise<HcpConnection> {
  let company: HcpCompany | null;
  try {
    company = await hcpFetchWithKey<HcpCompany>(apiKey, "company");
  } catch (err) {
    if (err instanceof HcpApiError && err.status === 401) throw new Error("Housecall Pro rejected that API key");
    throw err;
  }
  const data = {
    encryptedAuth: seal(JSON.stringify({ apiKey })),
    hcpCompanyId: company?.id != null ? String(company.id) : null,
    hcpCompanyName: typeof company?.name === "string" ? company.name.slice(0, 200) : null,
    lastSyncAt: null,
    lastSyncError: null,
    syncStartedAt: null,
  };
  const conn = await prisma.hcpConnection.upsert({ where: { companyId }, update: data, create: { companyId, ...data } });
  logger.info("Housecall Pro connected", { companyId, hcpCompanyId: conn.hcpCompanyId });
  return conn;
}

/** POST /jobs/{job_id}/attachments — multipart, field `file` (their documented name). 202 on accept. */
export async function uploadHcpJobAttachment(
  conn: HcpConnection,
  hcpJobId: string,
  file: { fileName: string; buffer: Buffer; contentType: string }
): Promise<void> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.contentType }), file.fileName);
  await hcpFetch(conn, `jobs/${encodeURIComponent(hcpJobId)}/attachments`, { method: "POST", form });
}
