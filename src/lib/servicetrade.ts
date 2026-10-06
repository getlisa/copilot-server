import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { ServicetradeConnection } from "@prisma/client";
import prisma from "./prisma";
import logger from "./logger";

/**
 * ServiceTrade connection + HTTP client — the zt.ts shape.
 *
 * ServiceTrade (api.servicetrade.com, fire/life-safety field service) is a plain JSON REST API:
 * every response is {data, messages:{error:[], success:[]}}, lists carry data.totalPages/page
 * (page=n query, 1-based), timestamps are Unix SECONDS. Auth is POST /auth {username, password}
 * → data.authToken, sent back as the PHPSESSID cookie. Sessions are long-lived (their docs:
 * "re-use the token; get a new one only when you need one"), there is no refresh token, so the
 * sealed blob keeps the login and a 401 re-logs in. Source: api.servicetrade.com/api/legacy-docs.
 */

const ST_API_URL = (process.env.SERVICETRADE_API_URL ?? "https://api.servicetrade.com/api").replace(/\/$/, "");

/** Server-level readiness: a sealing key must exist before any credential is accepted. */
export const isServicetradeConfigured = () =>
  Boolean(process.env.SERVICETRADE_TOKEN_KEY || process.env.QBO_TOKEN_KEY);

// ---------- encryption at rest (qbo.ts / zt.ts discipline, "servicetrade:" key domain) ----------

const key = () => {
  const secret = process.env.SERVICETRADE_TOKEN_KEY || process.env.QBO_TOKEN_KEY;
  if (!secret)
    throw new Error(
      "No sealing key — set QBO_TOKEN_KEY (shared) or SERVICETRADE_TOKEN_KEY; ServiceTrade credentials are never stored unencrypted"
    );
  return createHash("sha256").update(`servicetrade:${secret}`).digest();
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

export interface ServicetradeAuth {
  username: string;
  password: string;
  authToken: string;
}

const openAuth = (conn: ServicetradeConnection): ServicetradeAuth => {
  if (!conn.encryptedAuth) throw new Error("ServiceTrade connection has no stored credentials");
  return JSON.parse(unseal(conn.encryptedAuth)) as ServicetradeAuth;
};

// ---------- connection ----------

export const servicetradeConnectionFor = (companyId: number) =>
  prisma.servicetradeConnection.findUnique({ where: { companyId } });

export const servicetradeConnected = (conn: ServicetradeConnection | null): conn is ServicetradeConnection =>
  // stCompanyId is the vendorId every quote posts with — without it nothing can be filed.
  !!conn?.encryptedAuth && !!conn.stCompanyId;

export const disconnectServicetrade = (companyId: number) =>
  prisma.servicetradeConnection.deleteMany({ where: { companyId } });

// ---------- login ----------

interface LoginResult {
  authToken: string;
  stCompanyId: string;
  stCompanyName: string | null;
  stUserId: string;
}

/** POST /auth. 403 = bad credentials (verified in their docs), 400 = missing fields. */
export async function servicetradeLogin(username: string, password: string): Promise<LoginResult> {
  const res = await fetch(`${ST_API_URL}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => null)) as {
    data?: {
      authenticated?: boolean;
      authToken?: string | null;
      user?: { id?: number; company?: { id?: number; name?: string } };
    };
    messages?: { error?: string[] };
  } | null;
  if (!res.ok || !body?.data?.authToken) {
    throw new Error(
      res.status === 403 || res.status === 400
        ? "ServiceTrade rejected that username or password"
        : `ServiceTrade login failed (${res.status}) — try again shortly`
    );
  }
  const companyId = body.data.user?.company?.id;
  if (companyId == null) throw new Error("ServiceTrade login carries no company id");
  return {
    authToken: body.data.authToken,
    stCompanyId: String(companyId),
    stCompanyName: typeof body.data.user?.company?.name === "string" ? body.data.user.company.name : null,
    stUserId: body.data.user?.id != null ? String(body.data.user.id) : "",
  };
}

/** Connect: validate by actually logging in, then store sealed. A rejected login stores nothing. */
export async function connectServicetrade(
  companyId: number,
  username: string,
  password: string
): Promise<ServicetradeConnection> {
  const login = await servicetradeLogin(username, password);
  const data = {
    encryptedAuth: seal(JSON.stringify({ username, password, authToken: login.authToken } satisfies ServicetradeAuth)),
    stCompanyId: login.stCompanyId,
    stCompanyName: login.stCompanyName,
    stUserId: login.stUserId,
    accessTokenExpiresAt: null,
    lastSyncAt: null,
    lastSyncError: null,
    syncStartedAt: null,
    refreshLockUntil: null,
  };
  const conn = await prisma.servicetradeConnection.upsert({
    where: { companyId },
    update: data,
    create: { companyId, ...data },
  });
  logger.info("ServiceTrade connected", { companyId, stCompanyId: conn.stCompanyId });
  return conn;
}

const REFRESH_LOCK_MS = 30_000;

/**
 * A usable session token: the stored one unless it has been marked expired (a 401 sets
 * accessTokenExpiresAt to epoch 0), else a re-login serialized through the refresh_lock_until
 * row claim (QBO gap T-02, fixed from day one here too).
 */
async function sessionTokenFor(conn: ServicetradeConnection): Promise<string> {
  const auth = openAuth(conn);
  const expired = !!conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() <= Date.now();
  if (!expired) return auth.authToken;

  const claim = await prisma.servicetradeConnection.updateMany({
    where: {
      companyId: conn.companyId,
      OR: [{ refreshLockUntil: null }, { refreshLockUntil: { lt: new Date() } }],
    },
    data: { refreshLockUntil: new Date(Date.now() + REFRESH_LOCK_MS) },
  });
  if (claim.count === 0) {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const latest = await servicetradeConnectionFor(conn.companyId);
      if (latest?.encryptedAuth && !latest.accessTokenExpiresAt) {
        Object.assign(conn, latest);
        return openAuth(latest).authToken;
      }
    }
    throw new Error("ServiceTrade session refresh is taking too long — try again");
  }
  try {
    const login = await servicetradeLogin(auth.username, auth.password);
    const updated = await prisma.servicetradeConnection.update({
      where: { companyId: conn.companyId },
      data: {
        encryptedAuth: seal(JSON.stringify({ ...auth, authToken: login.authToken } satisfies ServicetradeAuth)),
        accessTokenExpiresAt: null,
        refreshLockUntil: null,
      },
    });
    Object.assign(conn, updated);
    return login.authToken;
  } catch (err) {
    await prisma.servicetradeConnection.updateMany({
      where: { companyId: conn.companyId },
      data: { refreshLockUntil: null },
    });
    throw err;
  }
}

const markExpired = async (conn: ServicetradeConnection) => {
  await prisma.servicetradeConnection.updateMany({
    where: { companyId: conn.companyId },
    data: { accessTokenExpiresAt: new Date(0) },
  });
  conn.accessTokenExpiresAt = new Date(0);
};

// ---------- HTTP ----------

export class ServicetradeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export interface StEnvelope<T = Record<string, unknown>> {
  data?: T & { totalPages?: number; page?: number };
  messages?: { error?: string[]; success?: string[] };
}

const errorText = (body: StEnvelope<unknown> | null) => (body?.messages?.error ?? []).join("; ").slice(0, 300);

/**
 * One ServiceTrade call: session cookie, 30s deadline, bounded retry ×3 on 5xx/429/network
 * (honouring Retry-After), never on other 4xx; a 401 forces one re-login. Returns `data`
 * (null on 204). `path` is relative to /api ("job?status=all").
 */
export async function servicetradeFetch<T = Record<string, unknown>>(
  conn: ServicetradeConnection,
  path: string,
  init?: { method?: string; body?: unknown; form?: FormData }
): Promise<(T & { totalPages?: number; page?: number }) | null> {
  let lastErr: Error = new Error("ServiceTrade request failed");
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = await sessionTokenFor(conn);
    let res: Response;
    try {
      res = await fetch(`${ST_API_URL}/${path.replace(/^\//, "")}`, {
        method: init?.method ?? "GET",
        headers: {
          Cookie: `PHPSESSID=${token}`,
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
    if (res.status === 401) {
      await markExpired(conn);
      lastErr = new ServicetradeApiError("ServiceTrade session expired", 401);
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
      lastErr = new ServicetradeApiError(`ServiceTrade returned ${res.status} on ${path.split("?")[0]}`, res.status);
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let body: StEnvelope<T> | null = null;
    try {
      body = text ? (JSON.parse(text) as StEnvelope<T>) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const detail = errorText(body);
      throw new ServicetradeApiError(
        `ServiceTrade returned ${res.status} on ${path.split("?")[0]}${detail ? `: ${detail}` : ""}`,
        res.status
      );
    }
    return (body?.data as (T & { totalPages?: number; page?: number }) | undefined) ?? null;
  }
  throw lastErr;
}

/** Walk a paged list (data.totalPages / page=n), handing each page's `data` to onPage. */
export async function servicetradePageAll<T = Record<string, unknown>>(
  conn: ServicetradeConnection,
  path: string,
  onPage: (data: T) => Promise<void>,
  maxPages = 200
): Promise<void> {
  for (let page = 1; page <= maxPages; page++) {
    const data = await servicetradeFetch<T>(conn, `${path}${path.includes("?") ? "&" : "?"}page=${page}`);
    if (!data) return;
    await onPage(data);
    const total = Number(data.totalPages ?? 1);
    if (!Number.isFinite(total) || page >= total) return;
  }
}

/** ServiceTrade entity-type constants (their docs: Constants → Entity Types). */
export const ST_ENTITY = { JOB: 3, QUOTE: 9, DEFICIENCY: 10, LOCATION: 11 } as const;
/** Attachment purposes: 7 = Generic Attachment. */
export const ST_PURPOSE_GENERIC = 7;

/**
 * POST /attachment — multipart: purposeId, entityType, entityId, description, uploadedFile
 * (their documented field names). Returns the attachment id.
 */
export async function uploadServicetradeAttachment(
  conn: ServicetradeConnection,
  entity: { type: number; id: string },
  file: { fileName: string; buffer: Buffer; contentType: string; description?: string }
): Promise<string | null> {
  const form = new FormData();
  form.append("purposeId", String(ST_PURPOSE_GENERIC));
  form.append("entityType", String(entity.type));
  form.append("entityId", entity.id);
  if (file.description) form.append("description", file.description);
  form.append("uploadedFile", new Blob([new Uint8Array(file.buffer)], { type: file.contentType }), file.fileName);
  const data = await servicetradeFetch<{ id?: number }>(conn, "attachment", { method: "POST", form });
  return data?.id != null ? String(data.id) : null;
}
