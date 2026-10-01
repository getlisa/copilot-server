import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { UptickConnection } from "@prisma/client";
import prisma from "./prisma";
import logger from "./logger";

/**
 * Uptick connection + HTTP client — the zt.ts shape, for a JSON:API backend.
 *
 * Uptick (onuptick.com, fire-protection field service) exposes a per-tenant REST API extended
 * with the JSON:API spec: resources arrive as {type, id, attributes, relationships}, lists as
 * {data: [...], included: [...], links: {next}}. Auth is OAuth2 PASSWORD grant against the
 * tenant's own /api/oauth2/token/ with an app Client ID/secret the client mints in
 * Control Panel > Uptick API (verified: Uptick's Airbyte connector and Postman collection both
 * do exactly this). Tokens live ~10h and come with a refresh_token.
 *
 * VERIFY-ON-TENANT (marked below): response/request shapes were taken from Uptick's public
 * connector manifest (v2.15 field lists) and help-center articles, not from a live call by this
 * code. The API version is pinned per the tenant's URL the client gave us (v2.8).
 */

export const UPTICK_API_VERSION = process.env.UPTICK_API_VERSION ?? "v2.8";

/** Server-level readiness: a sealing key must exist before any credential is accepted. */
export const isUptickConfigured = () =>
  Boolean(process.env.UPTICK_TOKEN_KEY || process.env.QBO_TOKEN_KEY);

// ---------- encryption at rest (qbo.ts / zt.ts discipline, "uptick:" key domain) ----------

const key = () => {
  const secret = process.env.UPTICK_TOKEN_KEY || process.env.QBO_TOKEN_KEY;
  if (!secret)
    throw new Error(
      "No sealing key — set QBO_TOKEN_KEY (shared) or UPTICK_TOKEN_KEY; Uptick credentials are never stored unencrypted"
    );
  return createHash("sha256").update(`uptick:${secret}`).digest();
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

/** The sealed blob. Password kept: the refresh token can be revoked, and a password re-grant is
 *  the only recovery (the same reasoning as ZenTrades). */
export interface UptickAuth {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  accessToken: string;
  refreshToken: string | null;
}

const openAuth = (conn: UptickConnection): UptickAuth => {
  if (!conn.encryptedAuth) throw new Error("Uptick connection has no stored credentials");
  return JSON.parse(unseal(conn.encryptedAuth)) as UptickAuth;
};

// ---------- connection ----------

export const uptickConnectionFor = (companyId: number) =>
  prisma.uptickConnection.findUnique({ where: { companyId } });

export const uptickConnected = (conn: UptickConnection | null): conn is UptickConnection =>
  !!conn?.encryptedAuth && !!conn.baseUrl;

export const disconnectUptick = (companyId: number) =>
  prisma.uptickConnection.deleteMany({ where: { companyId } });

/** "neighbourhoodfire.onuptick.com/dashboard/" → "https://neighbourhoodfire.onuptick.com". Host
 *  only, always https — whatever the admin pasted (Uptick's own connector normalizes the same). */
export function normalizeUptickBaseUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("An Uptick workspace URL is required");
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    throw new Error("That does not look like an Uptick workspace URL");
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new Error("That does not look like an Uptick workspace URL");
  return `https://${host}`;
}

// ---------- OAuth2 ----------

interface TokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

/** POST /api/oauth2/token/ (form-encoded, standard OAuth2). Bad user credentials arrive as 400
 *  invalid_grant, a bad client secret as 401 invalid_client (verified against the connector). */
async function uptickToken(baseUrl: string, form: Record<string, string>): Promise<TokenResult> {
  const res = await fetch(`${baseUrl}/api/oauth2/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  } | null;
  if (!res.ok || !body?.access_token) {
    const code = body?.error ?? "";
    throw new Error(
      code === "invalid_grant"
        ? "Uptick rejected that username or password"
        : code === "invalid_client"
          ? "Uptick rejected the Client ID or secret"
          : res.status === 404
            ? "No Uptick API at that workspace URL"
            : `Uptick login failed (${res.status}${code ? ` ${code}` : ""}) — try again shortly`
    );
  }
  const ttl = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: Number.isFinite(ttl) && ttl > 0 ? new Date(Date.now() + ttl * 1000) : null,
  };
}

const passwordGrant = (baseUrl: string, a: Omit<UptickAuth, "accessToken" | "refreshToken">) =>
  uptickToken(baseUrl, {
    grant_type: "password",
    client_id: a.clientId,
    client_secret: a.clientSecret,
    username: a.username,
    password: a.password,
  });

/** Connect: validate by actually obtaining a token, then store sealed. A rejected grant stores
 *  nothing. Reconnect overwrites. */
export async function connectUptick(
  companyId: number,
  input: { baseUrl: string; clientId: string; clientSecret: string; username: string; password: string }
): Promise<UptickConnection> {
  const baseUrl = normalizeUptickBaseUrl(input.baseUrl);
  const token = await passwordGrant(baseUrl, input);
  const auth: UptickAuth = {
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    username: input.username,
    password: input.password,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
  };
  const data = {
    baseUrl,
    encryptedAuth: seal(JSON.stringify(auth)),
    accessTokenExpiresAt: token.expiresAt,
    lastSyncAt: null,
    lastSyncError: null,
    syncStartedAt: null,
    refreshLockUntil: null,
  };
  const conn = await prisma.uptickConnection.upsert({
    where: { companyId },
    update: data,
    create: { companyId, ...data },
  });
  logger.info("Uptick connected", { companyId, baseUrl });
  return conn;
}

const REFRESH_LOCK_MS = 30_000;

/**
 * A usable bearer: the stored one while it has >60s left, else a refresh serialized through the
 * refresh_lock_until row claim (QBO gap T-02, fixed here from day one). refresh_token grant
 * first; a refused refresh (revoked, rotated) falls back to a password re-grant.
 */
async function accessTokenFor(conn: UptickConnection): Promise<string> {
  const auth = openAuth(conn);
  const fresh = conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() - Date.now() > 60_000;
  if (fresh) return auth.accessToken;

  const claim = await prisma.uptickConnection.updateMany({
    where: {
      companyId: conn.companyId,
      OR: [{ refreshLockUntil: null }, { refreshLockUntil: { lt: new Date() } }],
    },
    data: { refreshLockUntil: new Date(Date.now() + REFRESH_LOCK_MS) },
  });
  if (claim.count === 0) {
    // Someone else is refreshing: wait for their row, then use it.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const latest = await prisma.uptickConnection.findUnique({ where: { companyId: conn.companyId } });
      if (latest?.encryptedAuth && latest.accessTokenExpiresAt && latest.accessTokenExpiresAt.getTime() - Date.now() > 60_000) {
        Object.assign(conn, latest);
        return openAuth(latest).accessToken;
      }
    }
    throw new Error("Uptick session refresh is taking too long — try again");
  }
  try {
    let token: TokenResult;
    try {
      if (!auth.refreshToken) throw new Error("no refresh token");
      token = await uptickToken(conn.baseUrl, {
        grant_type: "refresh_token",
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
        refresh_token: auth.refreshToken,
      });
    } catch (err) {
      logger.warn("Uptick refresh grant failed; re-granting with the stored login", {
        companyId: conn.companyId,
        error: err instanceof Error ? err.message : String(err),
      });
      token = await passwordGrant(conn.baseUrl, auth);
    }
    const next: UptickAuth = {
      ...auth,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? auth.refreshToken,
    };
    const updated = await prisma.uptickConnection.update({
      where: { companyId: conn.companyId },
      data: {
        encryptedAuth: seal(JSON.stringify(next)),
        accessTokenExpiresAt: token.expiresAt,
        refreshLockUntil: null,
      },
    });
    Object.assign(conn, updated);
    return token.accessToken;
  } catch (err) {
    await prisma.uptickConnection.updateMany({
      where: { companyId: conn.companyId },
      data: { refreshLockUntil: null },
    });
    throw err;
  }
}

// ---------- JSON:API helpers (pure; exported for scripts/check-uptick.ts) ----------

export interface JaRef {
  type: string;
  id: string;
}
export interface JaResource {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: JaRef | JaRef[] | null }>;
}
export interface JaBody {
  data?: JaResource | JaResource[] | null;
  included?: JaResource[];
  links?: { next?: string | null };
  meta?: Record<string, unknown>;
  errors?: { detail?: string; title?: string; source?: { pointer?: string } }[];
}

export const jaRows = (body: unknown): JaResource[] => {
  const d = (body as JaBody | null)?.data;
  return Array.isArray(d) ? d : d ? [d] : [];
};

export const jaRelId = (r: JaResource | null | undefined, name: string): string | null => {
  const d = r?.relationships?.[name]?.data;
  if (!d || Array.isArray(d)) return null;
  return d.id != null ? String(d.id) : null;
};

/** {id, type, ...attributes, relationships} — attributes at the top level is what every reader
 *  wants; relationships kept verbatim so any id stays queryable from the raw store. */
export const jaFlatten = (r: JaResource): Record<string, unknown> => ({
  id: String(r.id),
  type: r.type,
  ...(r.attributes ?? {}),
  relationships: r.relationships ?? {},
});

/** The `included` array keyed "Type:id", so a resource's relationship can be resolved inline. */
export const jaIncluded = (body: unknown): Map<string, JaResource> => {
  const m = new Map<string, JaResource>();
  for (const r of (body as JaBody | null)?.included ?? []) m.set(`${r.type}:${r.id}`, r);
  return m;
};

/** The included resource behind `rel`, flattened, or null. Falls back to an id + case-insensitive
 *  type match so a casing difference between the ref and the included entry cannot lose it. */
export const jaResolve = (
  r: JaResource,
  rel: string,
  included: Map<string, JaResource>
): Record<string, unknown> | null => {
  const d = r.relationships?.[rel]?.data;
  if (!d || Array.isArray(d)) return null;
  const hit =
    included.get(`${d.type}:${d.id}`) ??
    [...included.values()].find(
      (x) => String(x.id) === String(d.id) && x.type.toLowerCase() === String(d.type).toLowerCase()
    );
  return hit ? jaFlatten(hit) : null;
};

/** A JSON:API write document. Relationships as {name: {type, id}}; null/blank ids omitted. */
export const jaDoc = (
  type: string,
  attributes: Record<string, unknown>,
  relationships: Record<string, { type: string; id: string | null | undefined }> = {},
  id?: string
): { data: Omit<JaResource, "id"> & { id?: string } } => {
  const rels: JaResource["relationships"] = {};
  for (const [name, ref] of Object.entries(relationships)) {
    if (ref.id != null && ref.id !== "") rels[name] = { data: { type: ref.type, id: String(ref.id) } };
  }
  return { data: { type, ...(id != null ? { id } : {}), attributes, relationships: rels } };
};

// ---------- HTTP ----------

export class UptickApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

const JSONAPI = "application/vnd.api+json";

/** `tasks/?x=1` → versioned path; `/api/...` and absolute URLs (links.next) pass through. */
const resolveUrl = (baseUrl: string, path: string) =>
  /^https?:\/\//.test(path)
    ? path
    : path.startsWith("/api/")
      ? `${baseUrl}${path}`
      : `${baseUrl}/api/${UPTICK_API_VERSION}/${path.replace(/^\//, "")}`;

/**
 * One Uptick call: bearer, JSON:API media type, 30s deadline, bounded retry ×3 on 5xx/429/
 * network (honouring Retry-After), never on other 4xx; a 401 forces one token refresh. Returns
 * the parsed body (the whole envelope — callers need `included` and `links`), null on 204.
 */
export async function uptickFetch(
  conn: UptickConnection,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<JaBody | null> {
  let lastErr: Error = new Error("Uptick request failed");
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = await accessTokenFor(conn);
    let res: Response;
    try {
      res = await fetch(resolveUrl(conn.baseUrl, path), {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: JSONAPI,
          ...(init?.body != null ? { "Content-Type": JSONAPI } : {}),
        },
        body: init?.body != null ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (res.status === 401) {
      await prisma.uptickConnection.updateMany({
        where: { companyId: conn.companyId },
        data: { accessTokenExpiresAt: new Date(0) },
      });
      conn.accessTokenExpiresAt = new Date(0);
      lastErr = new UptickApiError("Uptick session expired", 401);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await new Promise((r) =>
        setTimeout(
          r,
          Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 500 * 2 ** attempt
        )
      );
      lastErr = new UptickApiError(`Uptick returned ${res.status} on ${path.split("?")[0]}`, res.status);
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let body: JaBody | null = null;
    try {
      body = text ? (JSON.parse(text) as JaBody) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      // JSON:API error envelope: {errors:[{detail, source:{pointer}}]} — the pointer names the
      // offending field, which is exactly what a payload-shape failure needs to say.
      const detail = (body?.errors ?? [])
        .map(
          (e) =>
            `${e.source?.pointer ? `${e.source.pointer.replace(/^\/data\/attributes\//, "")}: ` : ""}${e.detail ?? e.title ?? ""}`
        )
        .filter(Boolean)
        .join("; ");
      throw new UptickApiError(
        `Uptick returned ${res.status} on ${path.split("?")[0]}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        res.status
      );
    }
    return body;
  }
  throw lastErr;
}

/**
 * Attach a file to a resource via Uptick's documents upload: GET the resource's documents
 * endpoint for a presigned S3 POST, then multipart-POST the file to the bucket (field order is
 * mandated by their docs). Their article documents no registration call afterwards — the
 * listing is keyed off the bucket prefix. VERIFY on tenant: that the file then shows on the task.
 */
export async function uploadUptickDocument(
  conn: UptickConnection,
  resource: "tasks" | "defectquotes",
  id: string,
  file: { fileName: string; buffer: Buffer; contentType: string }
): Promise<void> {
  const cfgBody = (await uptickFetch(conn, `/api/v2/uploads/${resource}/${id}/documents/`)) as
    | (JaBody & { upload?: Record<string, string> })
    | null;
  const up =
    cfgBody?.upload ??
    ((cfgBody?.meta as Record<string, unknown> | undefined)?.upload as Record<string, string> | undefined);
  if (!up?.bucket_url || !up.policy) throw new Error("Uptick did not return an upload policy for the document");
  const form = new FormData();
  form.append("key", String(up.key ?? "").replace("${filename}", file.fileName));
  form.append("acl", up.acl ?? "private");
  form.append("Content-Type", file.contentType);
  form.append("AWSAccessKeyId", up.aws_access_key ?? up.AWSAccessKeyId ?? "");
  form.append("policy", up.policy);
  form.append("signature", up.signature ?? "");
  if (up.aws_session_token) form.append("X-Amz-Security-Token", up.aws_session_token);
  form.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.contentType }), file.fileName);
  const res = await fetch(up.bucket_url, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Uptick document upload failed (${res.status})`);
}
