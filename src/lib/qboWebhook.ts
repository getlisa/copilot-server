import crypto from "crypto";

/**
 * QuickBooks Online webhooks — signature verification and payload parsing.
 *
 * Pure: no database, no network, no Prisma. `scripts/check-qbo-webhook.ts` imports it directly,
 * and that script runs inside the Docker build where neither is available.
 *
 * PAYLOAD. Intuit retired the legacy `eventNotifications[].dataChangeEvent.entities[]` envelope
 * at the CloudEvents deadline. A delivery is now a TOP-LEVEL JSON ARRAY of CloudEvents:
 *
 *   [{ specversion, id, source, type: "qbo.estimate.updated.v1", time,
 *      intuitentityid: "1234", intuitaccountid: "<realmId>", data: {} }]
 *
 * Four properties shape everything downstream:
 *   - `id` is the dedup key; a redelivery repeats it verbatim.
 *   - `type` carries entity AND operation as segments of one string, split on ".".
 *   - `intuitaccountid` is the realm, and the ONLY tenant identifier in the event.
 *   - `data` is EMPTY. A webhook is a pointer, never a payload — every event costs an API read.
 *
 * One delivery can carry events for several realms, and since we always re-read current state
 * from QuickBooks, out-of-order delivery is harmless: we read truth, not a diff.
 */

/**
 * The entities subscribed in the Intuit portal (2026-09-09), lowercased to match the `type`
 * segment. Anything else is parsed but marked unsupported — logged and skipped, never an error,
 * because one tenant's unexpected event must not put a shared endpoint at risk.
 *
 * `taxagency` is a deliberate proxy. `ingestSalesTax` reads TaxCode and TaxRate, and NEITHER is
 * offered as a webhook entity — so a TaxAgency event is a trigger to re-read tax, not data. It
 * fires when an agency is added or changed (a company setting up tax in a new jurisdiction); it
 * does NOT fire when a rate changes under an agency that already exists. Sales-tax freshness is
 * improved, not guaranteed, and the manual Sync stays the backstop.
 */
export const SUBSCRIBED_ENTITIES = [
  "account",
  "customer",
  "estimate",
  "item",
  "taxagency",
] as const;

export type QboEntity = (typeof SUBSCRIBED_ENTITIES)[number];

export interface ParsedQboEvent {
  /** CloudEvents `id` — the dedup key. */
  eventId: string;
  /** `intuitaccountid`. The only tenant identifier the event carries. */
  realmId: string;
  /** Null when the entity is not one we subscribed to; the row is still recorded, then skipped. */
  entity: QboEntity | null;
  /** Second segment of `type`. Never validated against an enum — see the note on refetch below. */
  operation: string;
  entityId: string | null;
  eventTime: string | null;
  /** Intuit's own `type` string, kept verbatim so the audit row records what they actually sent. */
  rawType: string | null;
  raw: unknown;
}

/**
 * Verify Intuit's `intuit-signature`: HMAC-SHA256 over the RAW request body, keyed with a
 * verifier token from the developer portal.
 *
 * MUST pass before any database write, including an audit row — writing first lets a replayed or
 * forged body create unauthenticated rows.
 *
 * TWO TOKENS, ONE ENDPOINT. The webhook URL is registered on BOTH Intuit keysets so the
 * sandbox->production flip needs no portal change, and Intuit issues a separate verifier token
 * per keyset. Holding only one would 401 every delivery from the other — and a 401 is the
 * response most likely to get a subscription disabled rather than retried. So we try each and
 * return WHICH matched: that name is the only thing identifying the keyset an event came from,
 * since nothing in the CloudEvent does.
 *
 * Base64 and hex are both accepted. Which encoding Intuit sends is not documented (their docs are
 * a JS SPA and are not machine-readable), and accepting both weakens neither branch.
 */
export interface VerifierToken {
  /** "sandbox" | "production" — logged on a match. */
  name: string;
  token: string;
}

/** Read the configured tokens. Order is irrelevant; both are tried. */
export function verifierTokens(env: NodeJS.ProcessEnv = process.env): VerifierToken[] {
  const candidates: { name: string; token: string | undefined }[] = [
    { name: "sandbox", token: env.QBO_WEBHOOK_VERIFIER_TOKEN_SANDBOX },
    { name: "production", token: env.QBO_WEBHOOK_VERIFIER_TOKEN_PRODUCTION },
  ];
  const out: VerifierToken[] = [];
  for (const c of candidates) {
    const token = c.token?.trim();
    if (token) out.push({ name: c.name, token });
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual THROWS on a length mismatch, so lengths are compared first. The length of an
  // HMAC digest is not a secret, so this leaks nothing.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Returns the NAME of the token that verified the body, or null if none did.
 *
 * Null means "this signature is wrong" and nothing else — the caller must have already
 * established that at least one token is configured (see `verifierTokens`), because "no tokens
 * loaded" is OUR failure and answers 503, not 401.
 */
export function matchVerifierToken(
  rawBody: string | Buffer,
  header: string | undefined,
  tokens: VerifierToken[]
): string | null {
  if (!header || tokens.length === 0) return null; // fail closed, never open
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");

  for (const { name, token } of tokens) {
    const digest = crypto.createHmac("sha256", token).update(body).digest();
    if (
      safeEqual(header, digest.toString("base64")) ||
      safeEqual(header.toLowerCase(), digest.toString("hex"))
    )
      return name;
  }
  return null;
}

/**
 * Parse a CloudEvents delivery into events we can act on.
 *
 * Pure and NEVER throws: a malformed body yields an empty array, which the receiver answers 200.
 * That includes the retired legacy envelope — its arrival shows up in logs rather than as a crash.
 *
 * The operation is kept verbatim rather than validated against an enum. Intuit's operation
 * vocabulary (Create / Update / Delete / Merge / Void / Emailed, and possibly more) is not fully
 * documented, and every operation is subscribed. The processor treats anything unrecognised as
 * "refetch", which is always safe because we re-read current state from the API regardless.
 */
export function parseQboEvents(body: unknown): ParsedQboEvent[] {
  if (!Array.isArray(body)) return [];

  const out: ParsedQboEvent[] = [];
  for (const raw of body) {
    if (raw == null || typeof raw !== "object") continue;
    const ev = raw as Record<string, unknown>;

    const eventId = typeof ev.id === "string" ? ev.id : null;
    const realmId = typeof ev.intuitaccountid === "string" ? ev.intuitaccountid : null;
    // No id => cannot dedup. No realm => cannot route. Either way it is noise, not an error.
    if (!eventId || !realmId) continue;

    const rawType = typeof ev.type === "string" ? ev.type : null;
    const segments = String(rawType ?? "")
      .toLowerCase()
      .split(".");
    const entityName = segments[1] ?? "";
    const entity = (SUBSCRIBED_ENTITIES as readonly string[]).includes(entityName)
      ? (entityName as QboEntity)
      : null;

    out.push({
      eventId,
      realmId,
      entity,
      operation: segments[2] || "unknown",
      entityId:
        typeof ev.intuitentityid === "string"
          ? ev.intuitentityid
          : ev.intuitentityid == null
            ? null
            : String(ev.intuitentityid),
      eventTime: typeof ev.time === "string" ? ev.time : null,
      rawType,
      raw,
    });
  }
  return out;
}

/**
 * Which reference-data stage an entity's change invalidates.
 *
 * `estimate` maps to no stage on purpose: there is no estimate ingest, and it is handled per-event
 * by the processor.
 */
export const STAGE_FOR_ENTITY: Record<QboEntity, string | null> = {
  account: "accounts",
  customer: "customers",
  item: "items",
  // A tax change also re-reads Preferences.TaxPrefs: Preferences is not among the subscribed
  // entities, and a company switching on Automated Sales Tax is overwhelmingly likely to touch
  // its agencies in the same sitting. Under AST Intuit IGNORES TxnTaxCodeRef and computes from
  // the address, which makes the whole snapshot tax model cosmetic — so this is worth catching.
  taxagency: "salesTax",
  estimate: null,
};
