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
 * Connection is per company and two-phase (US1): the admin enters the company's own Intuit
 * app keys (Client ID + Secret) in the settings Connections form, then completes QuickBooks'
 * OAuth consent — the account password never touches CLARA. Connected = tokens present.
 *
 * Posting triggers at quote COMPLETION (US2), never on proposal email. A quote has at most
 * one QBO estimate: re-completing after a reopen updates that same estimate in place (US6);
 * if it was deleted inside QBO, a fresh one is created and re-linked.
 *
 * Lines bill against the company's real QBO items (US5): the technician's per-line pick when
 * set, otherwise an exact name match against the item list, otherwise a newly created item.
 *
 * The only server-level config is QBO_REDIRECT_URI (Clara's callback URL, registered on each
 * client's Intuit app).
 */

const QBO_REDIRECT_URI = process.env.QBO_REDIRECT_URI ?? "";
const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

const apiBase = (conn: QboConnection) =>
  conn.environment === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";

/** Server-level readiness: only the callback URL — app keys are per company (US1). */
export const isQboConfigured = () => Boolean(QBO_REDIRECT_URI);

export const qboConnected = (conn: QboConnection | null): conn is QboConnection =>
  !!conn?.encryptedAuth;

// ---------- encryption at rest ----------
// App secrets and OAuth tokens grant write access to a client's accounting system. The key
// derives from JWT_ACCESS_SECRET to avoid provisioning another secret. ponytail: rotating
// JWT_ACCESS_SECRET orphans stored secrets/tokens (companies re-enter keys and reconnect);
// add a dedicated QBO_TOKEN_KEY if secret rotation ever becomes routine.

const key = () => createHash("sha256").update(`qbo:${jwtConfig.accessSecret}`).digest();

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

// ---------- credentials (US1) ----------

/**
 * Save (or replace) the company's Intuit app keys. Replacing keys clears any tokens issued
 * under the old app — they would be invalid anyway — so the row drops back to "not connected"
 * until the OAuth consent is redone.
 */
export async function saveQboCredentials(
  companyId: number,
  clientId: string,
  clientSecret: string,
  environment: "production" | "sandbox"
) {
  const data = {
    clientId,
    encryptedClientSecret: seal(clientSecret),
    environment,
    realmId: null,
    encryptedAuth: null,
    accessTokenExpiresAt: null,
  };
  await prisma.qboConnection.upsert({
    where: { companyId },
    create: { companyId, ...data },
    update: data,
  });
}

export const qboConnectionFor = (companyId: number) =>
  prisma.qboConnection.findUnique({ where: { companyId } });

// ---------- OAuth ----------

/**
 * State is a short-lived signed token, not a bare companyId: the callback is unauthenticated,
 * so an unsigned state would let anyone link their QBO account to an arbitrary company by
 * forging the redirect.
 */
export function qboAuthUrl(conn: QboConnection): string {
  const state = jwt.sign({ qbo: conn.companyId }, jwtConfig.accessSecret, { expiresIn: "15m" });
  const params = new URLSearchParams({
    client_id: conn.clientId,
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

async function tokenRequest(conn: QboConnection, body: Record<string, string>): Promise<TokenResponse> {
  const basic = Buffer.from(`${conn.clientId}:${unseal(conn.encryptedClientSecret)}`).toString("base64");
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

/** OAuth callback: exchange the code and store tokens on the company's credentials row. */
export async function connectQbo(companyId: number, code: string, realmId: string) {
  const conn = await qboConnectionFor(companyId);
  if (!conn) throw new Error("No QuickBooks app keys saved for this company");
  const t = await tokenRequest(conn, {
    grant_type: "authorization_code",
    code,
    redirect_uri: QBO_REDIRECT_URI,
  });
  await prisma.qboConnection.update({
    where: { id: conn.id },
    data: {
      realmId,
      encryptedAuth: seal(JSON.stringify({ accessToken: t.access_token, refreshToken: t.refresh_token })),
      accessTokenExpiresAt: expiry(t.expires_in),
    },
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
  const t = await tokenRequest(conn, { grant_type: "refresh_token", refresh_token: auth.refreshToken });
  await prisma.qboConnection.update({
    where: { id: conn.id },
    data: {
      encryptedAuth: seal(JSON.stringify({ accessToken: t.access_token, refreshToken: t.refresh_token })),
      accessTokenExpiresAt: expiry(t.expires_in),
    },
  });
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
  const res = await fetch(`${apiBase(conn)}/v3/company/${conn.realmId}${path}${sep}minorversion=75`, {
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
