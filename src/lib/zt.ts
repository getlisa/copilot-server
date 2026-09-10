import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { ZtConnection } from "@prisma/client";
import prisma from "./prisma";
import logger from "./logger";

/**
 * ZenTrades connection (ZenTrades plan 2.2). Connection only for now — the sync engine is a
 * later phase. Auth is a normal ZenTrades user login (there is no OAuth, no API key, and no
 * refresh token — their `request-from: INTEGRATOR` header is a label, not a credential), so
 * connecting means: validate the credentials by logging in, then keep them sealed at rest.
 * Login recipe verified against the production ZenTrades client in collection_agent_backend.
 */

const ZT_API_URL = process.env.ZT_API_URL ?? "https://services.zentrades.pro";

/** Server-level readiness: without a sealing key, seal() throws — fail at the card, not later. */
export const isZtConfigured = () =>
  Boolean(process.env.ZT_TOKEN_KEY || process.env.QBO_TOKEN_KEY);

// ---------- encryption at rest ----------
// Same discipline as qbo.ts (never JWT_ACCESS_SECRET — the platform team owns that and may
// rotate it), but no NEW env var required: QBO_TOKEN_KEY is this repo's own sealing secret and
// the "zt:" domain prefix below derives a distinct key from it. ZT_TOKEN_KEY remains as an
// optional override for anyone wanting independent rotation. What is NOT acceptable is no key
// at all — that stores client ZenTrades passwords readable in the database.
//
// Caveat this creates: rotating QBO_TOKEN_KEY now orphans stored ZenTrades credentials too,
// unless ZT_TOKEN_KEY is set. Both integrations then read "reconnect", which is the loud
// failure we want.

const key = () => {
  const secret = process.env.ZT_TOKEN_KEY || process.env.QBO_TOKEN_KEY;
  if (!secret)
    throw new Error(
      "No sealing key — set QBO_TOKEN_KEY (shared) or ZT_TOKEN_KEY; ZenTrades credentials are never stored unencrypted"
    );
  return createHash("sha256").update(`zt:${secret}`).digest();
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

/** The sealed blob. Password kept deliberately: session JWTs expire (~24h) and re-login with
 *  the stored credentials is the only recovery — ZenTrades issues no refresh token. */
export interface ZtAuth {
  username: string;
  password: string;
  accessToken: string;
}

export const openZtAuth = (conn: ZtConnection): ZtAuth => {
  if (!conn.encryptedAuth) throw new Error("ZenTrades connection has no stored credentials");
  return JSON.parse(unseal(conn.encryptedAuth)) as ZtAuth;
};

// ---------- connection ----------

export const ztConnectionFor = (companyId: number) =>
  prisma.ztConnection.findUnique({ where: { companyId } });

export const ztConnected = (conn: ZtConnection | null): conn is ZtConnection =>
  // ztCompanyId included for the same reason qboConnected requires realmId: without it every
  // later API call has nothing to scope to, and the failure should sit on the Connections
  // card next to the button that fixes it.
  !!conn?.encryptedAuth && !!conn.ztCompanyId;

/** Forget the connection. Nothing to revoke on the ZenTrades side; reconnect overwrites. */
export const disconnectZt = (companyId: number) =>
  prisma.ztConnection.deleteMany({ where: { companyId } });

// ---------- login ----------

interface ZtLoginResult {
  accessToken: string;
  ztCompanyId: string;
  ztCompanyName: string | null;
  ztUserId: string;
  expiresAt: Date | null;
}

/**
 * POST /api/auth/login → result["access-token"], a JWT whose payload carries companyId,
 * userId and exp. A hung login rides undici's ~300s default without the deadline.
 */
export async function ztLogin(username: string, password: string): Promise<ZtLoginResult> {
  const res = await fetch(`${ZT_API_URL}/api/auth/login?timestamp=${Date.now()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, rememberMe: true }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    // 400/401 are the credentials; anything else is their service. Body text is not surfaced —
    // it is ZenTrades' internal error prose, not something an admin here can act on.
    throw new Error(
      res.status === 400 || res.status === 401
        ? "ZenTrades rejected those credentials"
        : `ZenTrades login failed (${res.status}) — try again shortly`
    );
  }
  const data = (await res.json().catch(() => null)) as {
    result?: { "access-token"?: string; user?: { company?: { name?: string } } };
  } | null;
  const accessToken = data?.result?.["access-token"];
  if (!accessToken) throw new Error("ZenTrades login returned no access token");
  let payload: { companyId?: number; userId?: number; exp?: number };
  try {
    payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64").toString("utf8"));
  } catch {
    throw new Error("ZenTrades login returned an unreadable token");
  }
  if (payload.companyId == null)
    throw new Error("ZenTrades login token carries no company id");
  return {
    accessToken,
    ztCompanyId: String(payload.companyId),
    // Verified against a real login response (Sep 2026): the ZenTrades company name rides on
    // result.user.company.name. Display-only — the id is what scopes API calls.
    ztCompanyName:
      typeof data?.result?.user?.company?.name === "string"
        ? data.result.user.company.name
        : null,
    ztUserId: payload.userId != null ? String(payload.userId) : "",
    expiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
  };
}

/**
 * Connect a company: validate the credentials by actually logging in, then store them sealed.
 * A failed login stores nothing — the card never shows "Connected" for credentials that have
 * never worked.
 */
export async function connectZt(
  companyId: number,
  username: string,
  password: string
): Promise<ZtConnection> {
  const login = await ztLogin(username, password);
  const encryptedAuth = seal(
    JSON.stringify({ username, password, accessToken: login.accessToken } satisfies ZtAuth)
  );
  const data = {
    encryptedAuth,
    ztCompanyId: login.ztCompanyId,
    ztCompanyName: login.ztCompanyName,
    ztUserId: login.ztUserId,
    accessTokenExpiresAt: login.expiresAt,
  };
  const conn = await prisma.ztConnection.upsert({
    where: { companyId },
    update: data,
    create: { companyId, ...data },
  });
  // No username in the log line — same rule as the QBO auth logging.
  logger.info("ZenTrades connected", { companyId, ztCompanyId: conn.ztCompanyId });
  return conn;
}

// ---------- authenticated API client ----------

const REFRESH_LOCK_MS = 30_000;

/**
 * A usable access token, re-logging in inside a 60s pre-expiry window. Re-login is serialized
 * with a conditional row claim on refresh_lock_until (QBO gap T-02, fixed here from day one):
 * two concurrent completions racing a refresh would otherwise each replay a login. The loser
 * of the claim waits briefly and re-reads the row the winner refreshed. The new token is
 * written back onto the in-memory conn so sequential calls sharing it don't re-login each time.
 */
export async function accessTokenFor(conn: ZtConnection): Promise<string> {
  const auth = openZtAuth(conn);
  const expiresSoon =
    !conn.accessTokenExpiresAt || conn.accessTokenExpiresAt.getTime() - Date.now() < 60_000;
  if (!expiresSoon) return auth.accessToken;

  const claim = await prisma.ztConnection.updateMany({
    where: {
      companyId: conn.companyId,
      OR: [{ refreshLockUntil: null }, { refreshLockUntil: { lt: new Date() } }],
    },
    data: { refreshLockUntil: new Date(Date.now() + REFRESH_LOCK_MS) },
  });
  if (claim.count === 0) {
    // Another worker is refreshing. Give it a moment, then use whatever it stored.
    await new Promise((r) => setTimeout(r, 2_000));
    const fresh = await ztConnectionFor(conn.companyId);
    if (fresh?.encryptedAuth) {
      Object.assign(conn, fresh);
      return openZtAuth(fresh).accessToken;
    }
    return auth.accessToken; // last resort: the token we have, which may still work
  }
  try {
    const login = await ztLogin(auth.username, auth.password);
    const encryptedAuth = seal(
      JSON.stringify({ ...auth, accessToken: login.accessToken } satisfies ZtAuth)
    );
    const updated = await prisma.ztConnection.update({
      where: { companyId: conn.companyId },
      data: {
        encryptedAuth,
        accessTokenExpiresAt: login.expiresAt,
        refreshLockUntil: null,
      },
    });
    Object.assign(conn, updated);
    return login.accessToken;
  } catch (err) {
    await prisma.ztConnection.updateMany({
      where: { companyId: conn.companyId },
      data: { refreshLockUntil: null },
    });
    throw err;
  }
}

export class ZtApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

/**
 * One ZenTrades API call: token + tenant headers, 30s deadline, bounded retry ×3 on 5xx/429/
 * network (honouring Retry-After), never on other 4xx (they fail identically next time), the
 * token re-read on every attempt so a retry straddling an expiry doesn't replay a stale bearer.
 * A 401 mid-flight forces one re-login (session JWTs just expire) before counting as a failure.
 */
export async function ztFetch(
  conn: ZtConnection,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<unknown> {
  let lastErr: Error = new Error("ZenTrades request failed");
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = await accessTokenFor(conn);
    let res: Response;
    try {
      res = await fetch(`${ZT_API_URL}${path}${path.includes("?") ? "&" : "?"}timestamp=${Date.now()}`, {
        method: init?.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          "access-token": token,
          "company-id": conn.ztCompanyId ?? "",
          "user-id": conn.ztUserId ?? "",
          // WEB_APP, not INTEGRATOR: every request we have VERIFIED against their live API
          // (the user's captured curls) carried WEB_APP, and their servlets branch on this
          // value in places their own docs don't cover. Mimic what is known to work.
          "request-from": "WEB_APP",
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
      // Session expired server-side regardless of our expiry math: force one re-login by
      // aging the stored expiry, then loop (the next accessTokenFor re-logs in).
      await prisma.ztConnection.updateMany({
        where: { companyId: conn.companyId },
        data: { accessTokenExpiresAt: new Date(0) },
      });
      conn.accessTokenExpiresAt = new Date(0);
      lastErr = new ZtApiError("ZenTrades session expired", 401);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      // Carry ZenTrades' own error prose into the failure: their API 500s on request shapes
      // it dislikes, and "returned 500" alone is undiagnosable. Their envelope's description
      // when parseable, else a text snippet.
      const bodyText = await res.text().catch(() => "");
      let detail = "";
      try {
        const parsed = JSON.parse(bodyText) as {
          exception?: { error?: { description?: string; message?: string } };
        };
        detail = parsed.exception?.error?.description ?? parsed.exception?.error?.message ?? "";
      } catch {
        detail = bodyText;
      }
      detail = detail.replace(/\s+/g, " ").trim().slice(0, 300);
      const retryAfter = Number(res.headers.get("retry-after"));
      await new Promise((r) =>
        setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt)
      );
      lastErr = new ZtApiError(
        `ZenTrades returned ${res.status} on ${path.split("?")[0]}${detail ? `: ${detail}` : ""}`,
        res.status
      );
      continue;
    }
    const body = (await res.json().catch(() => null)) as
      | { status?: string; result?: unknown; exception?: { error?: { description?: string; message?: string } } }
      | null;
    if (!res.ok || body?.status === "error") {
      const msg =
        body?.exception?.error?.description ??
        body?.exception?.error?.message ??
        `ZenTrades returned ${res.status}`;
      // A blacklisted/expired session can arrive as an error BODY on any HTTP status —
      // ZenTrades invalidates older sessions when the same account logs in elsewhere (their
      // web app and CLARA sharing a login kick each other out). Force one re-login and retry
      // instead of failing the operation.
      if (/blacklist|session expired|invalid token/i.test(msg)) {
        await prisma.ztConnection.updateMany({
          where: { companyId: conn.companyId },
          data: { accessTokenExpiresAt: new Date(0) },
        });
        conn.accessTokenExpiresAt = new Date(0);
        lastErr = new ZtApiError(msg, 401);
        continue;
      }
      throw new ZtApiError(msg, res.status);
    }
    return body?.result ?? null;
  }
  throw lastErr;
}
