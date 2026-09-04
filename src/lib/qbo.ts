import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import jwt from "jsonwebtoken";
import type { QboConnection } from "@prisma/client";
import prisma from "./prisma";
import logger from "./logger";
import { jwtConfig } from "../config/jwt";
import type { LineItemDto, QuoteOptionTotal } from "../copilot/estimating/quoteDto";

/**
 * QuickBooks Online: post a quote into the client's QBO account as an Estimate (QBO PRD).
 *
 * Clara owns ONE Intuit app. Its Client ID / Secret / environment come from server env
 * (QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_ENVIRONMENT); only the OAuth TOKENS are per company.
 * The admin clicks Connect, completes QuickBooks' consent, and that is the whole setup — the
 * QuickBooks account password never touches CLARA. Connected = tokens present AND minted by the
 * environment this server currently runs (see `environment` below).
 *
 * DEFERRED, NOT CANCELLED — per-company Intuit app keys (PRD US1 as originally written, and the
 * shape this file had before 2026-09-04). Each client would create their own Intuit developer
 * app and paste a Client ID + Secret into Settings → Connections, stored encrypted per company
 * in `qbo_connections.client_id` / `.encrypted_client_secret`. Product decision (2026-09-04):
 * clients do not bring their own keys, so that path is deferred. To revive it: restore those two
 * columns, take clientId/secret from the row instead of the env constants below, and re-enable
 * the commented-out key form in technician-copilot's ConnectionsCard. Recorded on the PRD:
 * https://justclara.atlassian.net/wiki/spaces/EA/pages/115572739/ (footer comment 116260866).
 *
 * Posting triggers at quote COMPLETION (US2), never on proposal email. A quote has at most
 * one QBO estimate: re-completing after a reopen updates that same estimate in place (US6);
 * if it was deleted inside QBO, a fresh one is created and re-linked.
 *
 * Lines bill against the company's real QBO items (US5): the technician's per-line pick when
 * set, otherwise an exact name match against the item list, otherwise a newly created item.
 *
 * Server config: QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_ENVIRONMENT, QBO_REDIRECT_URI and
 * QBO_TOKEN_KEY. The redirect URI must match what is registered on Clara's Intuit app
 * character-for-character, and Intuit keeps a SEPARATE redirect list per keyset (Development
 * vs Production), so it has to be registered on both.
 */

const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID ?? "";
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET ?? "";
const QBO_REDIRECT_URI = process.env.QBO_REDIRECT_URI ?? "";
/**
 * Where to send the browser after the OAuth callback finishes — the app's Connections page.
 * Intuit hands the user to the API, which is not somewhere a person should be left standing.
 * Empty falls back to a plain confirmation page, so a missing value degrades instead of
 * redirecting nowhere. ALLOW_ORIGIN cannot serve here: it is "*".
 */
export const QBO_APP_RETURN_URL = process.env.QBO_APP_RETURN_URL ?? "";
/** Which Intuit keyset this server runs against. Sandbox keys only work on sandbox companies. */
export const QBO_ENVIRONMENT: "sandbox" | "production" =
  process.env.QBO_ENVIRONMENT === "sandbox" ? "sandbox" : "production";
const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

const apiBase = () =>
  QBO_ENVIRONMENT === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";

/**
 * Server-level readiness. The token key is included deliberately: without it `seal()` throws,
 * and a connection that only fails AFTER the client has granted consent at Intuit is the worst
 * possible place to discover a missing env var.
 */
export const isQboConfigured = () =>
  Boolean(QBO_CLIENT_ID && QBO_CLIENT_SECRET && QBO_REDIRECT_URI && process.env.QBO_TOKEN_KEY);

/**
 * Connected means: tokens present AND minted by the keyset this server is running now. Sandbox
 * tokens are worthless against production (and vice versa), so after an environment flip every
 * stale row reads "not connected" and the company is asked to reconnect — which is a clear
 * prompt instead of an opaque 401 on the next quote completion.
 */
export const qboConnected = (conn: QboConnection | null): conn is QboConnection =>
  !!conn?.encryptedAuth && conn.environment === QBO_ENVIRONMENT;

/** Tokens exist, but from the other keyset — the UI shows "reconnect required", not "connect". */
export const qboReconnectRequired = (conn: QboConnection | null): boolean =>
  !!conn?.encryptedAuth && conn.environment !== QBO_ENVIRONMENT;

// ---------- encryption at rest ----------
// OAuth tokens grant write access to a client's accounting system. The key comes from its own
// env var and NOT from JWT_ACCESS_SECRET: .env.example documents that secret as owned by the
// platform API ("must match the platform API's secret"), so a rotation by another team would
// silently orphan every stored token. Any string works — it is hashed to 32 bytes.
// No fallback on purpose: sealing under a foreign service's secret is worse than failing loudly.

const key = () => {
  const secret = process.env.QBO_TOKEN_KEY;
  if (!secret) throw new Error("QBO_TOKEN_KEY is not set — cannot seal or open QuickBooks tokens");
  return createHash("sha256").update(`qbo:${secret}`).digest();
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

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

// ---------- connection ----------

export const qboConnectionFor = (companyId: number) =>
  prisma.qboConnection.findUnique({ where: { companyId } });

/**
 * Forget a company's connection (QBO PRD US10 / D5 self-serve disconnect). Nothing is revoked at
 * Intuit — reconnecting simply overwrites the row. Deliberately does NOT clear Quote.qboEstimateId:
 * those estimates still exist in the QuickBooks company they were posted to.
 */
export const disconnectQbo = (companyId: number) =>
  prisma.qboConnection.deleteMany({ where: { companyId } });

// ---------- OAuth ----------

/**
 * State is a short-lived signed token, not a bare companyId: the callback is unauthenticated,
 * so an unsigned state would let anyone link their QBO account to an arbitrary company by
 * forging the redirect.
 */
export function qboAuthUrl(companyId: number): string {
  const state = jwt.sign({ qbo: companyId }, jwtConfig.accessSecret, { expiresIn: "15m" });
  const params = new URLSearchParams({
    client_id: QBO_CLIENT_ID,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: QBO_REDIRECT_URI,
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export function companyIdFromState(state: string): number | null {
  try {
    const payload = jwt.verify(state, jwtConfig.accessSecret) as { qbo?: unknown };
    return typeof payload.qbo === "number" ? payload.qbo : null;
  } catch {
    return null;
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const basic = Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`QBO token endpoint ${res.status}: ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

const expiry = (seconds: number) => new Date(Date.now() + seconds * 1000);

/**
 * OAuth callback: exchange the code for tokens and store them against the company. Upsert, not
 * update: with Clara-owned keys there is no pre-existing row to attach to — the first successful
 * consent CREATES the connection — and a reconnect after an environment flip must overwrite the
 * stale one. `environment` is stamped here so `qboConnected()` can spot tokens from the other
 * keyset later.
 */
export async function connectQbo(companyId: number, code: string, realmId: string) {
  const t = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: QBO_REDIRECT_URI,
  });
  const data = {
    realmId,
    environment: QBO_ENVIRONMENT,
    encryptedAuth: seal(JSON.stringify({ accessToken: t.access_token, refreshToken: t.refresh_token })),
    accessTokenExpiresAt: expiry(t.expires_in),
  };
  await prisma.qboConnection.upsert({
    where: { companyId },
    create: { companyId, ...data },
    update: data,
  });
}

/**
 * Valid access token, refreshing within a minute of expiry. Intuit rotates the refresh
 * token on every refresh, so the new pair is persisted before use.
 */
async function accessTokenFor(conn: QboConnection): Promise<string> {
  if (!conn.encryptedAuth || !conn.accessTokenExpiresAt)
    throw new Error("QuickBooks is not connected — complete the sign-in from Settings → Connections");
  const auth = JSON.parse(unseal(conn.encryptedAuth)) as AuthTokens;
  if (conn.accessTokenExpiresAt.getTime() - Date.now() > 60_000) return auth.accessToken;
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: auth.refreshToken });
  const encryptedAuth = seal(
    JSON.stringify({ accessToken: t.access_token, refreshToken: t.refresh_token })
  );
  const accessTokenExpiresAt = expiry(t.expires_in);
  await prisma.qboConnection.update({
    where: { id: conn.id },
    data: { encryptedAuth, accessTokenExpiresAt },
  });
  // Write the new pair back onto the in-memory row too. One syncQuoteToQbo makes 4-8 sequential
  // qboFetch calls, each of which calls this function with the SAME object; without this the
  // second call still sees the old expiry and refreshes again — replaying a refresh token Intuit
  // may already have rotated away. (The remaining half of that bug — two CONCURRENT syncs racing
  // the same refresh — needs a DB claim column; see docs/qbo/QBO-INTEGRATION.md T-02.)
  conn.encryptedAuth = encryptedAuth;
  conn.accessTokenExpiresAt = accessTokenExpiresAt;
  return t.access_token;
}

// ---------- API client ----------

class QboApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
  }
}

/** QBO reports a missing/deleted object as fault code 610 inside a 400 response. */
const isNotFound = (e: unknown) =>
  e instanceof QboApiError && (e.status === 404 || /"code"\s*:\s*"610"|Object Not Found/i.test(e.body));

async function qboFetch(conn: QboConnection, path: string, init?: RequestInit): Promise<any> {
  const token = await accessTokenFor(conn);
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${apiBase()}/v3/company/${conn.realmId}${path}${sep}minorversion=75`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new QboApiError(`QBO ${init?.method ?? "GET"} ${path} → ${res.status}: ${body}`, res.status, body);
  }
  return res.json();
}

const query = (conn: QboConnection, q: string) =>
  qboFetch(conn, `/query?query=${encodeURIComponent(q)}`);

/** QBO query literals escape single quotes with a backslash. */
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// ---------- customers (US4) ----------

/** DisplayName is QBO's unique customer key; colons are reserved (sub-customer separator). */
const displayName = (name: string) => name.replace(/:/g, " ").trim().slice(0, 100);

/**
 * Exact-name match reuses the existing QBO customer untouched (US4 — never a duplicate,
 * never a suffix, never an overwrite); a customer is created only when no name match exists.
 */
async function customerRefFor(
  conn: QboConnection,
  customer: { name: string; email?: string | null; phone?: string | null; address?: string | null }
): Promise<string> {
  const name = displayName(customer.name) || "Customer";
  const found = await query(conn, `select Id from Customer where DisplayName = '${esc(name)}'`);
  const existing = found.QueryResponse?.Customer?.[0]?.Id;
  if (existing) return String(existing);
  const created = await qboFetch(conn, "/customer", {
    method: "POST",
    body: JSON.stringify({
      DisplayName: name,
      ...(customer.email ? { PrimaryEmailAddr: { Address: customer.email } } : {}),
      ...(customer.phone ? { PrimaryPhone: { FreeFormNumber: customer.phone } } : {}),
      ...(customer.address ? { BillAddr: { Line1: customer.address } } : {}),
    }),
  });
  return String(created.Customer.Id);
}

// ---------- items (US5) ----------

export interface QboItem {
  id: string;
  name: string;
}

/**
 * The company's QBO item list, for the per-line dropdown and post-time matching.
 * ponytail: one page of 1000 — paginate when a client's item list actually exceeds it.
 */
export async function qboItems(conn: QboConnection): Promise<QboItem[]> {
  const found = await query(conn, `select Id, Name from Item where Active = true maxresults 1000`);
  const rows: { Id: string; Name: string }[] = found.QueryResponse?.Item ?? [];
  return rows.map((r) => ({ id: String(r.Id), name: r.Name }));
}

/** Item name QBO gets when a line has no explicit pick: catalog-shaped term over prose. */
export const autoItemName = (line: { isLabor: boolean; description: string; searchTerm?: string | null }) =>
  (line.isLabor ? "Labor" : (line.searchTerm?.trim() || line.description)).slice(0, 100);

async function createItem(conn: QboConnection, name: string): Promise<string> {
  const income = await query(conn, `select Id from Account where AccountType = 'Income' maxresults 1`);
  const account = income.QueryResponse?.Account?.[0];
  if (!account) throw new Error("QBO company has no Income account to bill items against");
  const created = await qboFetch(conn, "/item", {
    method: "POST",
    body: JSON.stringify({ Name: name, Type: "Service", IncomeAccountRef: { value: account.Id } }),
  });
  return String(created.Item.Id);
}

/**
 * Resolve every posting line to a QBO item id: the technician's stored pick wins; otherwise
 * exact (case-insensitive) name match against the live item list; otherwise create the item.
 * Created items are found by the name match on every later quote — no duplicates pile up.
 */
async function itemRefResolver(
  conn: QboConnection,
  lines: LineItemDto[]
): Promise<(line: LineItemDto) => string> {
  const list = await qboItems(conn);
  const byName = new Map(list.map((i) => [i.name.toLowerCase(), i.id]));
  const refs = new Map<string, string>();
  for (const line of lines) {
    if (line.qboItemId) {
      refs.set(line.id, line.qboItemId);
      continue;
    }
    const name = autoItemName(line);
    let id = byName.get(name.toLowerCase());
    if (!id) {
      id = await createItem(conn, name);
      byName.set(name.toLowerCase(), id);
    }
    refs.set(line.id, id);
  }
  return (line) => refs.get(line.id)!;
}

// ---------- estimate mapping (US3) ----------

export type QboEstimateLine =
  | {
      DetailType: "SalesItemLineDetail";
      Amount: number;
      Description: string;
      SalesItemLineDetail: { ItemRef: { value: string }; Qty?: number; UnitPrice?: number };
    }
  | {
      DetailType: "DescriptionOnly";
      DescriptionLineDetail: Record<string, never>;
      Description: string;
    };

/**
 * DTO prices already carry the markup, so QBO shows exactly what the customer was quoted.
 * Option groups are mutually exclusive alternatives: the CHOSEN group's lines post as real
 * priced lines alongside the base scope; every other group becomes a text note — never a
 * priced line, or QBO's total would sum alternatives the customer picked between (US3).
 * Callers must not invoke this while a choice is still pending (see optionGroupsOf).
 */
export function qboEstimateLines(
  dto: { lineItems: LineItemDto[]; optionTotals: QuoteOptionTotal[] },
  chosenOption: string | null,
  itemRefFor: (line: LineItemDto) => string
): QboEstimateLine[] {
  const lines: QboEstimateLine[] = dto.lineItems
    .filter((i) => !i.optionGroup || i.optionGroup === chosenOption)
    .map((i) => ({
      DetailType: "SalesItemLineDetail" as const,
      Amount: i.totalPrice ?? 0,
      Description: i.totalPrice == null ? `${i.description} — price pending` : i.description,
      SalesItemLineDetail: {
        ItemRef: { value: itemRefFor(i) },
        ...(i.quantity != null ? { Qty: i.quantity } : {}),
        ...(i.unitPrice != null ? { UnitPrice: i.unitPrice } : {}),
      },
    }));
  for (const o of dto.optionTotals.filter((o) => o.name !== chosenOption)) {
    lines.push({
      DetailType: "DescriptionOnly",
      DescriptionLineDetail: {},
      Description: `Alternate not selected — ${o.name}: $${o.total.toFixed(2)}. See proposal.`,
    });
  }
  return lines;
}

/** The quote's option-group names; non-empty means completion must carry a choice (US3). */
export const optionGroupsOf = (dto: { optionTotals: QuoteOptionTotal[] }) =>
  dto.optionTotals.map((o) => o.name);

// ---------- posting (US2/US6) ----------

/**
 * Post the quote as a QBO Estimate — or, when it already has one, UPDATE that estimate in
 * place with the current content (US6). If the estimate was deleted inside QBO, a fresh one
 * is created and re-linked. Returns the estimate id either way.
 */
export async function syncQuoteToQbo(
  conn: QboConnection,
  quote: { id: string; qboEstimateId: string | null; chosenOptionGroup: string | null },
  dto: { lineItems: LineItemDto[]; optionTotals: QuoteOptionTotal[] },
  customer: { name: string; email?: string | null; phone?: string | null; address?: string | null }
): Promise<{ estimateId: string; updated: boolean }> {
  if (dto.lineItems.length === 0) throw new Error("Quote has no line items to post");
  if (optionGroupsOf(dto).length > 0 && !quote.chosenOptionGroup)
    throw new Error("Quote has unresolved option groups — the customer's choice must be confirmed first");

  const customerRef = await customerRefFor(conn, customer);
  const itemRefFor = await itemRefResolver(conn, dto.lineItems.filter(
    (i) => !i.optionGroup || i.optionGroup === quote.chosenOptionGroup
  ));
  const payload = {
    CustomerRef: { value: customerRef },
    Line: qboEstimateLines(dto, quote.chosenOptionGroup, itemRefFor),
    PrivateNote: `CLARA quote ${quote.id}`,
    ...(customer.email ? { BillEmail: { Address: customer.email } } : {}),
  };

  // Update-in-place when this quote already posted (US6): QBO updates need the estimate's
  // current SyncToken, so read it first. A not-found (deleted inside QBO) falls through to
  // a fresh create; any other failure propagates — creating on a transient error would
  // silently duplicate the estimate.
  if (quote.qboEstimateId) {
    try {
      const current = await qboFetch(conn, `/estimate/${quote.qboEstimateId}`);
      const posted = await qboFetch(conn, "/estimate", {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          Id: quote.qboEstimateId,
          SyncToken: current.Estimate.SyncToken,
          sparse: true,
        }),
      });
      logger.info("QBO estimate updated", { quoteId: quote.id, estimateId: posted.Estimate.Id });
      return { estimateId: String(posted.Estimate.Id), updated: true };
    } catch (e) {
      if (!isNotFound(e)) throw e;
      logger.warn("QBO estimate missing on update — creating fresh", {
        quoteId: quote.id,
        estimateId: quote.qboEstimateId,
      });
    }
  }

  const posted = await qboFetch(conn, "/estimate", { method: "POST", body: JSON.stringify(payload) });
  const estimateId = String(posted.Estimate.Id);
  await prisma.quote.update({ where: { id: quote.id }, data: { qboEstimateId: estimateId } });
  logger.info("QBO estimate posted", { quoteId: quote.id, estimateId });
  return { estimateId, updated: false };
}
