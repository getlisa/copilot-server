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
 * Lines bill against the company's real QBO items (US5): the technician's per-line pick when set,
 * otherwise whatever the item REGISTRY resolves to. Registry lookups and item creation live in
 * lib/qboIngest — injected here as `EnsureItem` rather than imported, to keep the two modules
 * from depending on each other. An item is created at most once per company and its id is
 * reused by every later estimate (product rule, 2026-09-07).
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
  // realmId included: without it the UI reports Connected and the picker appears, but every
  // sync and every quote completion throws "connection has no realm" later, where nobody can
  // act on it. Refusing here puts the failure on the Connections card, next to Reconnect.
  !!conn?.encryptedAuth && !!conn.realmId && conn.environment === QBO_ENVIRONMENT;

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
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    /** Seconds Intuit asked us to wait, when it said so. Null when the header was absent. */
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message);
  }
}

/**
 * A read that could not be completed, as distinct from one that legitimately found nothing
 * (T-47). Returning a truncated list as if it were the whole list is what makes this dangerous:
 * the item registry would treat absent rows as "not in QuickBooks" and create duplicates.
 */
export class QboIncompleteReadError extends Error {
  constructor(readonly entity: string, readonly rowsRead: number) {
    super(`QBO ${entity} read stopped at ${rowsRead} rows without reaching the end`);
  }
}

/** QBO reports a missing/deleted object as fault code 610 inside a 400 response. */
export const isNotFound = (e: unknown) =>
  e instanceof QboApiError && (e.status === 404 || /"code"\s*:\s*"610"|Object Not Found/i.test(e.body));

/**
 * Per-request timeout (T-43). Without one, a hung Intuit socket holds a Fargate task and the
 * caller's HTTP request open indefinitely — Node's fetch has no default timeout at all.
 */
const QBO_TIMEOUT_MS = 30_000;
/**
 * Transient failures get a bounded retry: 5xx, 429, and socket/timeout errors. These are
 * upstream blips, not request problems. Clara runs ONE Intuit app across every client (D-1),
 * so throttling is pooled and a single 429 would otherwise discard a whole sync — which is
 * exactly the failure this exists to absorb. Mirrors the house pattern in `serpapi.ts`.
 */
const QBO_RETRIES = 3;
const QBO_BACKOFF_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retryable: the server said it was its own fault, or asked us to slow down, or we never got an
 * answer. A 4xx other than 429 is the request's fault and will fail identically next time —
 * retrying it just multiplies a duplicate-name or validation error.
 */
const isTransient = (e: unknown): boolean => {
  if (e instanceof QboApiError) return e.status === 429 || e.status >= 500;
  // AbortError from our own timeout, plus TypeError from a socket failure.
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError" || e instanceof TypeError);
};

/** Intuit may say exactly how long to wait; prefer that over guessing. */
const retryAfterMs = (e: unknown, attempt: number): number => {
  if (e instanceof QboApiError && e.retryAfterSeconds != null) return e.retryAfterSeconds * 1000;
  return QBO_BACKOFF_MS * 2 ** attempt;
};

export async function qboFetch(conn: QboConnection, path: string, init?: RequestInit): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${apiBase()}/v3/company/${conn.realmId}${path}${sep}minorversion=75`;
  let last: unknown;

  for (let attempt = 0; attempt <= QBO_RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = retryAfterMs(last, attempt - 1);
      logger.warn("QBO call failed transiently, retrying", {
        path,
        attempt,
        waitMs: wait,
        status: last instanceof QboApiError ? last.status : undefined,
      });
      await sleep(wait);
    }
    try {
      // The token is re-read on every attempt on purpose: a retry that straddles an expiry
      // must not replay the stale bearer it was about to be rejected for.
      const token = await accessTokenFor(conn);
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(QBO_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) {
        const body = await res.text();
        const ra = Number(res.headers.get("Retry-After"));
        throw new QboApiError(
          `QBO ${init?.method ?? "GET"} ${path} → ${res.status}: ${body}`,
          res.status,
          body,
          Number.isFinite(ra) && ra > 0 ? ra : null
        );
      }
      return await res.json();
    } catch (e) {
      last = e;
      if (!isTransient(e) || attempt === QBO_RETRIES) throw e;
    }
  }
  throw last;
}

export const query = (conn: QboConnection, q: string) =>
  qboFetch(conn, `/query?query=${encodeURIComponent(q)}`);

/**
 * Every row of an entity, not just the first page. QBO caps a query at 1000 rows and paginates
 * with STARTPOSITION (1-based), so a company with 1001 items used to silently lose the tail —
 * which also meant a name lookup missed items past row 1000 and created duplicates (G9).
 * `maxPages` is a runaway guard, not a real limit.
 */
export async function queryAll<T>(
  conn: QboConnection,
  entity: string,
  where = "",
  {
    pageSize = 1000,
    maxPages = 50,
    /**
     * Whether the caller needs EVERY row. True for a mirror sync, where a short read would look
     * like deletions. False for a bounded probe — `{pageSize: 1, maxPages: 1}` asking "does a
     * customer with this name exist" is complete the moment it has an answer, and treating its
     * full first page as truncation would turn a successful lookup into a thrown error.
     */
    expectAll = true,
  } = {}
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const start = page * pageSize + 1;
    const q = `select * from ${entity}${where ? ` where ${where}` : ""} startposition ${start} maxresults ${pageSize}`;
    const found = await query(conn, q);
    const batch: T[] = found.QueryResponse?.[entity] ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
    if (!expectAll) return rows;
  }
  // Hitting the guard means there was MORE, and we stopped. Previously this returned the partial
  // list and logged a warning nobody reads, so 50,000 rows were reported as the company's total —
  // and every row past it looked, to the item registry and the customer picker, like something
  // QuickBooks does not have. Failing is the honest answer; T-45 records it as a partial sync.
  throw new QboIncompleteReadError(entity, rows.length);
}

/** QBO query literals escape single quotes with a backslash. */
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// ---------- customers (US4) ----------
// Customer resolution moved to lib/qboIngest::ensureQboCustomer and is injected below, for the
// same reason items are: the registry needs this module's API client. It also does more than a
// name match now — a customer picked or created on the estimate screen is linked to the quote,
// and an estimate can only be posted once that customer exists in QuickBooks with an id
// (product rule, 2026-09-07).

/** Resolve the QBO customer id this estimate bills to, creating the customer if it must. */
export type EnsureCustomer = (
  conn: QboConnection,
  companyId: number,
  quote: { id: string; customerId: number | null },
  fallback: { name: string; email?: string | null; phone?: string | null; address?: string | null }
) => Promise<string>;

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

// createItem moved to lib/qboIngest.ts::ensureQboItem, which also records the id so the item is
// never created a second time, and sets Taxable at creation from the line's own taxable flag
// (G14 — threaded through by itemRefResolver below).
//
// The income account is NOT the admin's choice yet (G10, still open): `ensureQboItem` accepts one
// and `GET /qbo/income-accounts` exists to offer it, but nothing stores or forwards it, so
// creation still falls to `firstIncomeAccountId` — deterministic (active Income accounts by name,
// mirror before a live query) but arbitrary. This comment used to claim both were done.


/**
 * Resolve every posting line to a QBO item id: the technician's stored pick wins; otherwise
 * exact (case-insensitive) name match against the live item list; otherwise create the item.
 * Created items are found by the name match on every later quote — no duplicates pile up.
 */
/**
 * How this module gets an item id without depending on the registry that provides it.
 *
 * Injected rather than imported: the registry (lib/qboIngest) needs this module's API client, so
 * importing it back would make the two mutually dependent — a cycle that typechecks, survives on
 * CJS interop, and then breaks in a way no test would explain. The caller wires the real one in.
 */
export type EnsureItem = (
  conn: QboConnection,
  companyId: number,
  identity: { pricebookItemId?: number | null; name: string; taxable?: boolean | null }
) => Promise<string>;

/**
 * Resolve every posting line to a QuickBooks item id, creating an item only when one does not
 * already exist — and never creating the same item twice, across estimates.
 *
 * Ordering is the product rule (2026-09-07): items are ensured HERE, before the estimate payload
 * is built, because an estimate line cannot reference an item that has no id yet. The ids handed
 * back are what the estimate carries, and they are persisted in `qbo_item_links` so the next
 * estimate that uses the same item reuses the id instead of creating a duplicate.
 *
 * A line's identity is its pricebook row where it has one — stable across renames on either
 * side — and its name otherwise, which covers labor and ad-hoc lines (46% of production lines,
 * including every labor line). The technician's explicit per-line pick still wins over both.
 */
async function itemRefResolver(
  conn: QboConnection,
  lines: LineItemDto[],
  ensureItem: EnsureItem
): Promise<(line: LineItemDto) => string> {
  const companyId = conn.companyId;

  // pricebook_code -> pricebook_items.id, in one query. (company_id, code) is unique.
  const codes = [...new Set(lines.map((l) => l.pricebookCode).filter((c): c is string => !!c))];
  const bookRows = codes.length
    ? await prisma.pricebookItem.findMany({
        where: { companyId, code: { in: codes } },
        select: { id: true, code: true },
      })
    : [];
  const bookIdByCode = new Map(bookRows.map((r) => [r.code, r.id]));

  const refs = new Map<string, string>();
  for (const line of lines) {
    if (line.qboItemId) {
      refs.set(line.id, line.qboItemId);
      continue;
    }
    refs.set(
      line.id,
      await ensureItem(conn, companyId, {
        pricebookItemId: line.pricebookCode ? bookIdByCode.get(line.pricebookCode) ?? null : null,
        name: autoItemName(line),
        /**
         * Taxability, carried onto the QuickBooks ITEM at creation (gap G14 / T-07).
         *
         * `ensureQboItem` has always accepted this and set `Taxable` when given it; this caller
         * passed nothing, so every item CLARA created inherited whatever the client's QuickBooks
         * defaults to. That is not cosmetic: an item carries its own tax setting, and it is what
         * QuickBooks applies to every LATER transaction billed against that item — including
         * invoices the client raises by hand, long after this estimate. A material created as
         * non-taxable quietly under-charges tax from then on, inside someone's accounting system,
         * with nothing in CLARA to reveal it.
         *
         * This estimate's own lines are unaffected either way: each carries an explicit
         * `TaxCodeRef` of TAX or NON (see qboEstimateLines), so what the customer signed and what
         * QuickBooks bills for THIS document already agree. This fixes what happens next.
         *
         * Only used at creation. An item is created once and its id reused forever, so where two
         * lines share a name and disagree on taxability, the first one to be posted decides — and
         * changing it afterwards is a QuickBooks-side edit, not something to overwrite from here.
         */
        taxable: line.taxable,
      })
    );
  }
  return (line) => refs.get(line.id)!;
}

// ---------- estimate mapping (US3) ----------

export type QboEstimateLine =
  | {
      DetailType: "SalesItemLineDetail";
      Amount: number;
      Description: string;
      SalesItemLineDetail: {
        ItemRef: { value: string };
        Qty?: number;
        UnitPrice?: number;
        /** "TAX" or "NON" — always set, so a sparse update cannot leave stale tax behind. */
        TaxCodeRef: { value: "TAX" | "NON" };
      };
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
  itemRefFor: (line: LineItemDto) => string,
  /**
   * Whether this estimate declares tax at all.
   *
   * Every line carries an explicit `TaxCodeRef` EITHER WAY — TAX only when the estimate is taxed
   * and the line is taxable, NON otherwise. Omitting it when untaxed looked more conservative
   * and was in fact the bug: re-completion posts the update with `sparse: true`, under which an
   * omitted field means "leave what is there". An estimate that once carried Tucson 9.1% and is
   * then cleared would keep being taxed by QuickBooks while CLARA's document says it is not.
   * Marking every line NON makes the tax zero whatever the transaction-level code still says,
   * so the books can never charge tax the signed estimate does not show (T-63).
   */
  taxed = false
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
        TaxCodeRef: { value: taxed && i.taxable ? "TAX" : "NON" },
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
 *
 * Also returns the `SyncToken` QuickBooks assigned to the estimate it just wrote. The caller
 * stores it so a later `estimate.update` webhook can tell an edit made inside QuickBooks from
 * the echo of this write. `null` means the response carried no token — the post still
 * succeeded, so this must not fail the sync; it degrades to "unknown", which the drain treats
 * as a baseline to establish rather than as drift.
 */
export async function syncQuoteToQbo(
  conn: QboConnection,
  quote: {
    id: string;
    qboEstimateId: string | null;
    chosenOptionGroup: string | null;
    customerId: number | null;
    /** The snapshotted rate, or null when this estimate declares no tax. */
    salesTaxId: number | null;
  },
  dto: {
    lineItems: LineItemDto[];
    optionTotals: QuoteOptionTotal[];
    /** Payable total, for the post-hoc comparison against QuickBooks' own figure. */
    totalWithTax?: number;
  },
  customer: { name: string; email?: string | null; phone?: string | null; address?: string | null },
  deps: { ensureItem: EnsureItem; ensureCustomer: EnsureCustomer }
): Promise<{ estimateId: string; updated: boolean; syncToken: string | null }> {
  if (dto.lineItems.length === 0) throw new Error("Quote has no line items to post");
  if (optionGroupsOf(dto).length > 0 && !quote.chosenOptionGroup)
    throw new Error("Quote has unresolved option groups — the customer's choice must be confirmed first");

  // The customer is ensured FIRST: an estimate cannot reference one that has no id yet.
  const customerRef = await deps.ensureCustomer(conn, conn.companyId, quote, customer);
  const itemRefFor = await itemRefResolver(
    conn,
    dto.lineItems.filter((i) => !i.optionGroup || i.optionGroup === quote.chosenOptionGroup),
    deps.ensureItem
  );
  // The QuickBooks tax CODE for the rate this estimate was snapshotted with (T-63). A code is
  // what a transaction references; the rates underneath it are what QuickBooks cascades to reach
  // a percentage — which is why the code row, not a member rate row, is what goes here.
  //
  // Absent means absent: with no snapshot, `TxnTaxDetail` is omitted entirely rather than sent
  // as zero, preserving the distinction between "no tax configured" and "a deliberate 0%" all
  // the way into the customer's books (F20).
  const taxCodeRef = quote.salesTaxId == null ? null : await qboTaxCodeRef(conn, quote.salesTaxId);
  if (quote.salesTaxId != null && !taxCodeRef)
    logger.warn("Quote carries a sales-tax rate with no QuickBooks code; posting untaxed", {
      quoteId: quote.id,
      salesTaxId: quote.salesTaxId,
      realmId: conn.realmId,
    });

  const payload = {
    CustomerRef: { value: customerRef },
    Line: qboEstimateLines(dto, quote.chosenOptionGroup, itemRefFor, !!taxCodeRef),
    PrivateNote: `CLARA quote ${quote.id}`,
    ...(customer.email ? { BillEmail: { Address: customer.email } } : {}),
    ...(taxCodeRef ? { TxnTaxDetail: { TxnTaxCodeRef: { value: taxCodeRef } } } : {}),
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
      return {
        estimateId: String(posted.Estimate.Id),
        updated: true,
        syncToken: syncTokenOf(posted),
      };
    } catch (e) {
      if (!isNotFound(e)) throw e;
      logger.warn("QBO estimate missing on update — creating fresh", {
        quoteId: quote.id,
        estimateId: quote.qboEstimateId,
      });
    }
  }

  // Before creating, look for an estimate this quote ALREADY posted (T-48). The id is persisted
  // only after QBO returns it, so a crash, a timeout, or a retried request in between leaves a
  // real estimate in the customer's books that CLARA has no record of — and the next completion
  // creates a second one. `PrivateNote` has always carried the quote id and was never read back;
  // it is not a filterable field, so the query narrows by customer and matches in memory.
  const adopted = await findPostedEstimate(conn, quote.id, customerRef);
  if (adopted) {
    await prisma.quote.update({ where: { id: quote.id }, data: { qboEstimateId: adopted.id } });
    logger.warn("Adopted an orphaned QBO estimate instead of creating a duplicate", {
      quoteId: quote.id,
      estimateId: adopted.id,
    });
    const posted = await qboFetch(conn, "/estimate", {
      method: "POST",
      body: JSON.stringify({ ...payload, Id: adopted.id, SyncToken: adopted.syncToken, sparse: true }),
    });
    return {
      estimateId: String(posted.Estimate.Id),
      updated: true,
      syncToken: syncTokenOf(posted),
    };
  }

  const posted = await qboFetch(conn, "/estimate", { method: "POST", body: JSON.stringify(payload) });
  const estimateId = String(posted.Estimate.Id);
  await prisma.quote.update({ where: { id: quote.id }, data: { qboEstimateId: estimateId } });
  logger.info("QBO estimate posted", { quoteId: quote.id, estimateId });
  logTotalDelta(quote.id, estimateId, dto, posted);
  return { estimateId, updated: false, syncToken: syncTokenOf(posted) };
}

/**
 * The `SyncToken` off an estimate write response, as a string, or null when it is absent.
 *
 * QuickBooks types this as a numeric string ("0", "1", …) and has been observed to send it as
 * a JSON number, so it is stringified rather than compared as-is: "3" and 3 are the same token
 * and must not read as drift. Defensive on the whole path because a missing token is not worth
 * failing a post that already landed in the customer's books.
 */
export function syncTokenOf(posted: any): string | null {
  const token = posted?.Estimate?.SyncToken;
  if (token == null) return null;
  const asString = String(token);
  // An empty string is not a token. Storing it would make the next event compare "" against a
  // real value and report drift on a quote nobody touched.
  return asString === "" ? null : asString;
}

/**
 * Compare what CLARA printed with what QuickBooks computed, and say so when they differ.
 *
 * They legitimately can. QuickBooks cascades a GROUP tax code component by component and rounds
 * each one, while CLARA applies the combined percentage once — Tucson (7.1 + 2) against a large
 * subtotal can land a cent apart. That is not worth failing a post over, but it is worth being
 * able to find later, which is why this is a structured line with both figures rather than a
 * silent shrug. CLARA's number stays authoritative for the signed document.
 */
function logTotalDelta(
  quoteId: string,
  estimateId: string,
  dto: { lineItems: LineItemDto[]; optionTotals: QuoteOptionTotal[]; totalWithTax?: number },
  posted: any
) {
  const qboTotal = Number(posted?.Estimate?.TotalAmt);
  const claraTotal = dto.totalWithTax;
  if (!Number.isFinite(qboTotal) || claraTotal == null) return;
  const delta = Math.round((qboTotal - claraTotal) * 100) / 100;
  if (delta === 0) return;
  logger.warn("QBO estimate total differs from CLARA's", {
    quoteId,
    estimateId,
    claraTotal,
    qboTotal,
    delta,
  });
}

/**
 * The QuickBooks TaxCode id for one of CLARA's sales-tax rates, in the realm currently connected.
 *
 * Realm-scoped deliberately: a company that reconnects to a different QuickBooks file has rates
 * whose old code ids mean nothing there, and sending one would either fail or — worse — match an
 * unrelated code in the new file. No row for this realm means this rate cannot be expressed here.
 */
async function qboTaxCodeRef(conn: QboConnection, salesTaxId: number): Promise<string | null> {
  // Under Automated Sales Tax, Intuit ignores TxnTaxCodeRef and computes from the address. Send
  // one anyway and the estimate silently disagrees with the document CLARA printed, with nothing
  // to reveal it — so the code is withheld and the lines go out NON, matching what was signed.
  // `null`/undefined means the preference has not been read yet, which is not evidence of AST.
  if (conn.partnerTaxEnabled === true) {
    logger.warn("QBO company uses Automated Sales Tax; posting untaxed rather than a code Intuit would discard", {
      companyId: conn.companyId,
      realmId: conn.realmId,
    });
    return null;
  }
  if (conn.usingSalesTax === false) return null;

  const row = await prisma.salesTaxQb.findFirst({
    where: {
      salesTaxId,
      companyId: conn.companyId,
      realmId: conn.realmId ?? "",
      qboType: "TaxCode",
      isDeleted: false,
      isActive: true,
    },
    select: { qboId: true },
  });
  return row?.qboId ?? null;
}

/**
 * An estimate already in QuickBooks for this quote, if one is there (T-48).
 *
 * Scoped to the customer so the scan stays small, and matched on the exact `PrivateNote` this
 * module writes. Deliberately best-effort: a failure here must not block a legitimate post, so
 * it degrades to "not found" and the caller creates — the same behaviour as before this existed.
 */
async function findPostedEstimate(
  conn: QboConnection,
  quoteId: string,
  customerRef: string
): Promise<{ id: string; syncToken: string } | null> {
  const marker = `CLARA quote ${quoteId}`;
  try {
    // Paginated: QBO returns 100 rows by default, and a customer with a long history would hide
    // the very orphan this exists to find — reporting "no duplicate" and creating a second one.
    const rows = await queryAll<{ Id: string; SyncToken: string; PrivateNote?: string }>(
      conn,
      "Estimate",
      `CustomerRef = '${esc(customerRef)}'`
    );
    const hit = rows.find((r) => r?.PrivateNote === marker);
    return hit ? { id: String(hit.Id), syncToken: String(hit.SyncToken) } : null;
  } catch (e) {
    logger.warn("Could not check for an existing QBO estimate; creating", {
      quoteId,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
