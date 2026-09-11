import { randomUUID } from "crypto";
import prisma from "./prisma";
import logger from "./logger";
import { qboConnected, qboConnectionFor, qboFetch, isNotFound, syncTokenOf } from "./qbo";
import type { QboConnection } from "@prisma/client";
import { runQboSync, QboSyncBusyError } from "./qboIngest";
import {
  MAX_ATTEMPTS,
  backoffMs,
  mergeOutcome,
  stagesForEntities,
  unparseableEventId,
  estimateDriftVerdict,
  estimateEventAction,
  ESTIMATE_ACTION_RANK,
  type EstimateEventAction,
  type DrainOutcome,
  type OutcomeStatus,
  type ParsedQboEvent,
  type QboEntity,
} from "./qboWebhook";

/**
 * Drains `qbo_webhook_events` — the processing half of the QuickBooks webhook feature.
 *
 * The receiver verifies, records and answers 200 in milliseconds. Everything expensive happens
 * here, because a webhook's `data` is EMPTY and acting on one always costs a QuickBooks API read.
 *
 * WHY A LOOP AND NOT A QUEUE — see the `QboWebhookEvent` model comment. This service has one ECS
 * task, no queue and no worker, and a table already tracks what SQS would.
 *
 * THE DRAIN INTERVAL IS THE DEBOUNCE. Every event in a pass is grouped by (company, stage) and
 * the stage runs ONCE, so a bulk edit touching ten customers costs one refresh.
 *
 * The arithmetic that decides an event's fate — outcome precedence, stage coalescing, backoff —
 * lives in `qboWebhook.ts`, which has no I/O and IS unit-tested. This file owns only the database
 * choreography around it.
 */

/** How often the drain wakes. Also, therefore, the coalescing window. */
const DRAIN_INTERVAL_MS = 10_000;
/** Rows per pass. */
const BATCH_SIZE = 200;
/** A row claimed and never settled returns to the queue after this. */
const CLAIM_STALE_MS = 10 * 60 * 1000;
/** Settled rows older than this are pruned. `failed` rows are kept — they are the diagnostic. */
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Rows pruned per pass, so housekeeping can never dominate one. */
const PRUNE_BATCH = 500;
/**
 * Rows per `createMany`. Postgres caps bind parameters at 65535 and each row binds ~18 columns,
 * so a single statement tops out near 3,600 rows. A 5 MB delivery could carry more; Prisma does
 * not chunk for us, and an unchunked overflow would throw, answer 503, and have Intuit redeliver
 * the identical oversized body until it gave up — losing every event in it.
 */
const INSERT_CHUNK = 1_000;

/**
 * Record a verified delivery. Returns how many rows were NEW.
 *
 * `skipDuplicates` on the unique `event_id` IS the dedup: Intuit repeats the CloudEvents `id`
 * verbatim on redelivery, so a redelivery inserts nothing and the drain never sees it twice.
 *
 * It also USED to mean a redelivery could not rescue a row that had exhausted its retries — the
 * insert was skipped and the dead row stayed dead, which quietly contradicted the design's claim
 * that Intuit's redelivery is the recovery path. So a redelivery now revives `failed` rows.
 */
export async function recordQboWebhookEvents(
  events: ParsedQboEvent[],
  keyset: string
): Promise<number> {
  if (events.length === 0) return 0;

  const data = events.map((e) => ({
    eventId: e.eventId,
    realmId: e.realmId,
    keyset,
    entity: e.entity,
    operation: e.operation,
    entityId: e.entityId,
    // An unparseable timestamp must not reject the event; the CloudEvent is kept in `raw`.
    eventTime: e.eventTime && !Number.isNaN(Date.parse(e.eventTime)) ? new Date(e.eventTime) : null,
    raw: e.raw as object,
    // An entity we do not subscribe to is recorded for visibility and settled immediately. Never
    // an error: one tenant's unexpected event must not put a shared endpoint at risk.
    status: e.entity ? "queued" : "skipped",
  }));

  let created = 0;
  for (let i = 0; i < data.length; i += INSERT_CHUNK) {
    const { count } = await prisma.qboWebhookEvent.createMany({
      data: data.slice(i, i + INSERT_CHUNK),
      skipDuplicates: true,
    });
    created += count;
  }

  const revived = await prisma.qboWebhookEvent.updateMany({
    where: { eventId: { in: events.map((e) => e.eventId) }, status: "failed" },
    data: { status: "queued", attempts: 0, lastError: null, nextAttemptAt: null },
  });
  if (revived.count > 0)
    logger.info("QBO webhook redelivery revived exhausted events", { count: revived.count });

  return created;
}

/**
 * Persist a delivery we could not parse.
 *
 * These are verified bytes from Intuit — the signature passed — so discarding them with only a log
 * line means the feed can go dark and leave nothing in the table to show it. The id is a hash of
 * the body so redeliveries of the same unreadable payload still collapse onto one row.
 */
export async function recordUnparseableDelivery(
  rawBody: Buffer | string,
  keyset: string
): Promise<void> {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  await prisma.qboWebhookEvent.createMany({
    data: [
      {
        eventId: unparseableEventId(body),
        realmId: "unknown",
        keyset,
        entity: null,
        operation: "unparseable",
        raw: { bytes: body.length, body: body.toString("utf8").slice(0, 8_000) },
        status: "skipped",
      },
    ],
    skipDuplicates: true,
  });
}

/**
 * Every company connected to this realm THROUGH THE KEYSET THAT SIGNED THE DELIVERY.
 *
 * DELIBERATELY A FAN-OUT, NOT A UNIQUE KEY. collection_agent_backend fixed the same ambiguity with
 * a partial unique index, because there a wrong answer meant its dialer calling people on behalf
 * of an abandoned tenant. Here the cost is one extra API read and a second mirror being correctly
 * refreshed — and this realm may already be attached to more than one company row.
 *
 * The keyset filter closes a gap the column itself created: one URL serves BOTH Intuit keysets, so
 * a delivery signed by the production token must not drive a sandbox connection that happens to
 * share a realm id. `qboConnected` compares against the SERVER's environment, which is a different
 * question. Applied at drain time rather than at record time, so the eventual production flip
 * makes stale sandbox rows unroutable instead of newly routable.
 */
export async function companiesForRealm(realmId: string, keyset: string | null): Promise<number[]> {
  const rows = await prisma.qboConnection.findMany({ where: { realmId } });
  return rows
    .filter((r) => qboConnected(r) && (keyset === null || r.environment === keyset))
    .map((r) => r.companyId);
}

/**
 * An estimate deleted in QuickBooks: forget the id, so nothing points into a file that no longer
 * holds it.
 *
 * Separate from the edit path because it needs no API read — the event itself is the whole fact.
 *
 * Raw SQL, like every drift write here, so `Quote.updatedAt` is NOT bumped. See `setDriftColumns`.
 */
async function handleEstimateDeleted(companyId: number, entityId: string): Promise<"done"> {
  // `qbo_synced_at` goes with the id. Leaving it set would have the card say "synced at <time>"
  // about an estimate that no longer exists — a different lie from the one we are fixing.
  //
  // The drift pair goes too: a token and a "changed in QuickBooks" mark both describe an estimate
  // that is gone, and leaving them would have the next post inherit a baseline belonging to a
  // deleted file.
  //
  // updateMany semantics (every matching row), not findFirst: if two quotes ever share an
  // estimate id, all of them are pointing at the deleted file.
  const count = await prisma.$executeRaw`
    UPDATE "public"."quotes"
       SET "qbo_estimate_id" = NULL,
           "qbo_synced_at" = NULL,
           "qbo_sync_token" = NULL,
           "qbo_remote_changed_at" = NULL
     WHERE "company_id" = ${companyId}
       AND "qbo_estimate_id" = ${entityId}`;
  if (count > 0)
    logger.info("QBO estimate deleted in QuickBooks; cleared the stored id", {
      companyId,
      qboEstimateId: entityId,
      quotes: count,
    });
  return "done";
}

/**
 * Write the drift columns WITHOUT touching `updatedAt`, and only if the row still holds the token
 * we based the decision on.
 *
 * TWO REASONS THIS IS RAW SQL.
 *
 * `Quote.updatedAt` is `@updatedAt`, so any `prisma.quote.update` stamps it — that is exactly the
 * mechanism `touchQuote` uses to move an edited estimate to the top of the list, and the list is
 * ordered `updatedAt desc` as a work queue. A bookkeeping write from a webhook nobody triggered
 * must not reorder somebody's screen. Baseline adoption is the mass case: on the first
 * compare-able event after this ships every already-posted quote has a NULL token, so a Prisma
 * update would march the entire completed list to the top in webhook-arrival order.
 *
 * And the WHERE clause is a compare-and-set. Between reading the quote and this write there is an
 * Intuit round trip — up to three retries against a 30s timeout — and a completion can land inside
 * it. Without the guard a stale snapshot overwrites the fresh token, and the next event reports
 * drift on a quote nobody edited. Zero rows means we lost the race; the winner's value is the
 * newer truth, so it stands.
 */
async function setDriftColumns(
  quoteId: string,
  expectedToken: string | null,
  set: { syncToken?: string | null; remoteChangedAt?: Date | null }
): Promise<boolean> {
  // Two spelled-out statements rather than a composed fragment: `IS NULL` and `= $1` are
  // different SQL, and Prisma's tagged template does not compose into a WHERE fragment.
  const count =
    expectedToken === null
      ? await prisma.$executeRaw`
          UPDATE "public"."quotes"
             SET "qbo_sync_token" = COALESCE(${set.syncToken ?? null}, "qbo_sync_token"),
                 "qbo_remote_changed_at" = ${set.remoteChangedAt ?? null}
           WHERE "id" = ${quoteId} AND "qbo_sync_token" IS NULL`
      : await prisma.$executeRaw`
          UPDATE "public"."quotes"
             SET "qbo_sync_token" = COALESCE(${set.syncToken ?? null}, "qbo_sync_token"),
                 "qbo_remote_changed_at" = ${set.remoteChangedAt ?? null}
           WHERE "id" = ${quoteId} AND "qbo_sync_token" = ${expectedToken}`;
  return count > 0;
}

/**
 * An estimate changed in QuickBooks — ours, or the client's own edit?
 *
 * QBO bumps `SyncToken` on every change to an estimate, whoever made it, and the CloudEvent says
 * only that something happened. So the token QuickBooks reports now is compared against the one
 * we stored when we last wrote: equal means this event is the echo of our own post, and anything
 * further means a human edited the estimate inside QuickBooks.
 *
 * That matters because the update-in-place path (US6) overwrites unconditionally. Recording the
 * drift is what lets re-completion warn instead of silently discarding the client's edit.
 *
 * THE QUOTE IS LOOKED UP BEFORE THE API READ, deliberately. Most estimates in a client's books
 * were never posted by CLARA, and a read we can skip is a read that cannot burn rate limit or
 * fail. That lookup is indexed on (company_id, qbo_estimate_id) — see phase9.sql.
 */
async function handleEstimateChanged(
  companyId: number,
  conn: QboConnection,
  entityId: string
): Promise<"done" | "skipped"> {
  const quote = await prisma.quote.findFirst({
    where: { companyId, qboEstimateId: entityId },
    // Deterministic, so that if two quotes ever share an estimate id the same one is flagged
    // every pass rather than whichever the planner happened to return.
    orderBy: { id: "asc" },
    select: { id: true, qboSyncToken: true, qboRemoteChangedAt: true },
  });
  if (!quote) return "skipped";

  let remoteToken: string | null;
  try {
    const res = await qboFetch(conn, `/estimate/${entityId}`);
    remoteToken = syncTokenOf(res);
  } catch (e) {
    // NOT treated as a delete. `isNotFound` also matches fault 610, and this branch now runs on
    // create/update/void/merge and on operations nobody has seen — so a 404 here can equally be
    // QBO's read-after-write lag on a fresh estimate, or a stored id belonging to a DIFFERENT
    // QuickBooks file (disconnect deliberately keeps `qboEstimateId`, and the id is not
    // realm-scoped). Clearing the linkage on that guess would strand a live estimate and have the
    // next completion post a second one. Only an explicit `delete` operation clears linkage; this
    // is recorded and left alone.
    if (!isNotFound(e)) throw e;
    logger.warn("QBO estimate not found on drift read; linkage left intact", {
      companyId,
      qboEstimateId: entityId,
      quoteId: quote.id,
    });
    return "skipped";
  }

  const verdict = estimateDriftVerdict(
    quote.qboSyncToken,
    remoteToken,
    quote.qboRemoteChangedAt !== null
  );

  switch (verdict) {
    case "skip":
      return "skipped";

    // No baseline: the quote posted before this column existed, or that write's response carried
    // no token. Adopt what QuickBooks reports rather than calling it drift — an unknown is not
    // evidence of an edit, and a false "changed in QuickBooks" warning teaches people to ignore
    // the real one. The cost is honest: an edit made before the baseline existed is invisible.
    case "baseline": {
      const won = await setDriftColumns(quote.id, null, { syncToken: remoteToken });
      if (won)
        logger.info("QBO estimate sync token baseline adopted from QuickBooks", {
          companyId,
          quoteId: quote.id,
          qboEstimateId: entityId,
          syncToken: remoteToken,
        });
      return "done";
    }

    // The echo of our own write, or a drift already recorded. Nothing to change either way —
    // `qbo_sync_token` deliberately stays at our last write, which is what the column means.
    case "unchanged":
    case "already-flagged":
      return "done";

    case "drift": {
      const won = await setDriftColumns(quote.id, quote.qboSyncToken, {
        remoteChangedAt: new Date(),
      });
      if (won)
        logger.warn("QBO estimate edited inside QuickBooks", {
          companyId,
          quoteId: quote.id,
          qboEstimateId: entityId,
          ourSyncToken: quote.qboSyncToken,
          remoteSyncToken: remoteToken,
        });
      return "done";
    }
  }
}

type ClaimedRow = Awaited<ReturnType<typeof prisma.qboWebhookEvent.findMany>>[number];

/**
 * Take up to BATCH_SIZE eligible rows for this pass.
 *
 * `nextAttemptAt` is what stops a stuck tenant owning every pass: a requeued row is pushed into
 * the future, so it stops competing with everybody else's fresh events for the batch. Without it,
 * ordering by `createdAt` meant 200 permanently-requeuing rows from one realm filled the batch
 * forever — exactly the blast radius BATCH_SIZE was supposed to bound.
 */
async function claimBatch(claimToken: string): Promise<ClaimedRow[]> {
  const now = new Date();
  const queued = await prisma.qboWebhookEvent.findMany({
    where: {
      status: "queued",
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
    select: { id: true },
  });
  if (queued.length === 0) return [];

  // Claim by token, not by count. A count alone cannot say WHICH rows this pass won when two
  // passes overlap on part of the same id list; `status: "queued"` makes the claim atomic.
  await prisma.qboWebhookEvent.updateMany({
    where: { id: { in: queued.map((r) => r.id) }, status: "queued" },
    data: { status: "running", claimedAt: now, claimToken },
  });
  return prisma.qboWebhookEvent.findMany({ where: { claimToken } });
}

/**
 * Write the pass's outcomes.
 *
 * EVERY WRITE CARRIES THE CLAIM TOKEN. Without it a pass whose rows were stale-reclaimed by
 * another would happily overwrite the new owner's work — and "a pass only ever touches rows
 * carrying its own token" is the contract this file claims to hold.
 *
 * Rows sharing an identical payload settle in ONE statement. A batch of 200 done rows was 200
 * sequential round trips; it is now one.
 */
async function settleOutcomes(
  outcomes: Map<bigint, DrainOutcome>,
  claimToken: string
): Promise<Record<OutcomeStatus, number>> {
  const tally: Record<OutcomeStatus, number> = { done: 0, skipped: 0, failed: 0, queued: 0 };
  const groups = new Map<string, { data: Record<string, unknown>; ids: bigint[] }>();

  for (const [id, o] of outcomes) {
    const data: Record<string, unknown> = {
      status: o.status,
      claimToken: null,
      claimedAt: null,
      doneCompanies: o.doneCompanies,
      ...(o.attempts === undefined ? {} : { attempts: o.attempts }),
      ...(o.error === undefined ? {} : { lastError: o.error.slice(0, 1000) }),
      // A requeue waits; anything terminal clears the marker so a revival starts clean.
      nextAttemptAt:
        o.status === "queued" ? new Date(Date.now() + backoffMs(o.attempts ?? 1)) : null,
    };
    const key = JSON.stringify(data, (_k, v) => (v instanceof Date ? v.toISOString() : v));
    const group = groups.get(key);
    if (group) group.ids.push(id);
    else groups.set(key, { data, ids: [id] });
    tally[o.status] += 1;
  }

  for (const { data, ids } of groups.values()) {
    const { count } = await prisma.qboWebhookEvent.updateMany({
      where: { id: { in: ids }, claimToken },
      data,
    });
    if (count !== ids.length)
      logger.warn("QBO webhook settle lost a claim; rows were reclaimed mid-pass", {
        expected: ids.length,
        written: count,
      });
  }
  return tally;
}

/** Housekeeping: settled rows do not need to be kept forever. `failed` rows are never pruned. */
async function pruneLedger(): Promise<number> {
  const stale = await prisma.qboWebhookEvent.findMany({
    where: {
      status: { in: ["done", "skipped"] },
      createdAt: { lt: new Date(Date.now() - RETENTION_MS) },
    },
    take: PRUNE_BATCH,
    select: { id: true },
  });
  if (stale.length === 0) return 0;
  const { count } = await prisma.qboWebhookEvent.deleteMany({
    where: { id: { in: stale.map((r) => r.id) } },
  });
  logger.info("QBO webhook ledger pruned", { deleted: count });
  return count;
}

/**
 * One drain pass. Safe to call concurrently: rows are claimed with a token, and a pass only ever
 * touches rows carrying its own — enforced in `settleOutcomes`, not merely asserted here.
 */
export async function drainQboWebhookEvents(): Promise<{
  claimed: number;
  done: number;
  skipped: number;
  requeued: number;
  failed: number;
}> {
  const empty = { claimed: 0, done: 0, skipped: 0, requeued: 0, failed: 0 };

  // Rows a previous pass claimed and never settled (a killed task, a deploy mid-flight).
  await prisma.qboWebhookEvent.updateMany({
    where: { status: "running", claimedAt: { lt: new Date(Date.now() - CLAIM_STALE_MS) } },
    data: { status: "queued", claimToken: null, claimedAt: null },
  });

  const claimToken = randomUUID();
  const rows = await claimBatch(claimToken);
  if (rows.length === 0) {
    await pruneLedger();
    return empty;
  }

  const outcomes = new Map<bigint, DrainOutcome>();
  const record = (id: bigint, o: DrainOutcome) =>
    outcomes.set(id, mergeOutcome(outcomes.get(id), o));
  const settled = (status: OutcomeStatus, doneCompanies: number[] = []): DrainOutcome => ({
    status,
    doneCompanies,
  });

  // Resolve each (realm, keyset) once, however many events it sent.
  const byRealmKeyset = new Map<string, number[]>();
  for (const row of rows) {
    const key = `${row.realmId} ${row.keyset ?? ""}`;
    if (!byRealmKeyset.has(key))
      byRealmKeyset.set(key, await companiesForRealm(row.realmId, row.keyset));
  }
  const companiesFor = (row: ClaimedRow) =>
    byRealmKeyset.get(`${row.realmId} ${row.keyset ?? ""}`) ?? [];

  const unroutable = rows.filter((r) => companiesFor(r).length === 0);
  if (unroutable.length > 0) {
    // Not an error. An unknown realm, or one whose only connection was minted by the other
    // keyset — which is every production delivery while this server runs sandbox.
    logger.info("QBO webhook events not routable to a connected company", {
      realms: [...new Set(unroutable.map((r) => r.realmId))],
      events: unroutable.length,
    });
    for (const row of unroutable) record(row.id, settled("skipped"));
  }

  // (company, event) pairs. A company already recorded as done for a row is NOT redone: without
  // that, a permanently broken sibling on a shared realm requeued the row forever and re-ran the
  // healthy company's full mirror pull on every pass.
  const byCompany = new Map<number, ClaimedRow[]>();
  for (const row of rows.filter((r) => companiesFor(r).length > 0))
    for (const companyId of companiesFor(row)) {
      if (row.doneCompanies.includes(companyId)) continue;
      byCompany.set(companyId, [...(byCompany.get(companyId) ?? []), row]);
    }

  const failure = (row: ClaimedRow, companyId: number, message: string): DrainOutcome => {
    const attempts = row.attempts + 1;
    return {
      status: attempts >= MAX_ATTEMPTS ? "failed" : "queued",
      // The company is named in the message so one ledger row can still answer "which tenant".
      error: `company ${companyId}: ${message}`,
      attempts,
      doneCompanies: [],
    };
  };

  for (const [companyId, companyRows] of byCompany) {
    const estimateRows = companyRows.filter((r) => r.entity === "estimate");
    const stageRows = companyRows.filter((r) => r.entity && r.entity !== "estimate");
    const stages = stagesForEntities(stageRows.map((r) => r.entity as QboEntity));

    if (stages.length > 0) {
      try {
        // `markComplete: false` keeps `lastSyncAt` meaning "last COMPLETE sync" (T-45).
        await runQboSync(companyId, stages, { markComplete: false });
        for (const row of stageRows) record(row.id, settled("done", [companyId]));
      } catch (e) {
        if (e instanceof QboSyncBusyError) {
          // RE-QUEUE, never skip. The running sync will finish, but it may have started before
          // the change that triggered us, so dropping the event would lose the update. Attempts
          // ARE bumped: waiting for a lock is not a failure, but an unbounded wait is, and a
          // permanently stuck claim must not livelock the row forever.
          for (const row of stageRows)
            record(row.id, failure(row, companyId, "a QuickBooks sync was already running"));
        } else {
          const message = e instanceof Error ? e.message : String(e);
          logger.error("QBO webhook stage refresh failed", { companyId, stages, error: message });
          for (const row of stageRows) record(row.id, failure(row, companyId, message));
        }
      }
    }

    // ESTIMATES ARE COALESCED PER ENTITY, like stages are per (company, stage) — the drain
    // interval is the debounce, and that contract applied to estimates too or ten edits to one
    // estimate inside one window cost ten identical Intuit reads against a rate limit shared by
    // every CLARA client. Rows for the same estimate collapse onto the highest-priority action
    // (delete beats compare beats ignore), and every row that fed the group takes its outcome.
    if (estimateRows.length > 0) {
      const groups = new Map<string, { action: EstimateEventAction; rows: typeof estimateRows }>();
      const skippedRows: typeof estimateRows = [];
      for (const row of estimateRows) {
        if (!row.entityId) {
          skippedRows.push(row);
          continue;
        }
        const action = estimateEventAction(row.operation);
        const existing = groups.get(row.entityId);
        if (!existing) groups.set(row.entityId, { action, rows: [row] });
        else {
          existing.rows.push(row);
          if (ESTIMATE_ACTION_RANK[action] > ESTIMATE_ACTION_RANK[existing.action])
            existing.action = action;
        }
      }
      for (const row of skippedRows) record(row.id, settled("skipped", [companyId]));

      // Resolved ONCE for the company, not once per event: the connection cannot change inside a
      // pass, and the old shape re-read it for every estimate row.
      const conn = groups.size > 0 ? await qboConnectionFor(companyId) : null;
      for (const [entityId, group] of groups) {
        try {
          let outcome: "done" | "skipped";
          if (group.action === "delete") outcome = await handleEstimateDeleted(companyId, entityId);
          // `emailed` bumps SyncToken without anyone editing anything — see estimateEventAction.
          else if (group.action === "ignore") outcome = "skipped";
          // Disconnected between the delivery and this pass. Skipped rather than failed: retrying
          // cannot help, and piling these into `failed` poisons the count that means "this tenant
          // needs reconnecting".
          else if (!qboConnected(conn)) outcome = "skipped";
          else outcome = await handleEstimateChanged(companyId, conn, entityId);
          for (const row of group.rows) record(row.id, settled(outcome, [companyId]));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          for (const row of group.rows) record(row.id, failure(row, companyId, message));
        }
      }
    }
  }

  // TOTAL SETTLE. Any claimed row no branch recorded would otherwise sit in `running` until the
  // stale reclaim and then repeat that forever, invisibly. Costs nothing when every branch behaves.
  for (const row of rows)
    if (!outcomes.has(row.id)) {
      logger.warn("QBO webhook row claimed but not handled", {
        id: String(row.id),
        entity: row.entity,
        operation: row.operation,
      });
      record(row.id, settled("skipped"));
    }

  const tally = await settleOutcomes(outcomes, claimToken);
  await pruneLedger();

  const result = {
    claimed: rows.length,
    done: tally.done,
    skipped: tally.skipped,
    requeued: tally.queued,
    failed: tally.failed,
  };
  logger.info("QBO webhook drain pass", result);
  return result;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastPassAt: Date | null = null;

/** Liveness, so a stalled drain is distinguishable from an idle one. */
export function qboWebhookDrainStatus(): {
  started: boolean;
  running: boolean;
  lastPassAt: string | null;
} {
  return { started: timer !== null, running, lastPassAt: lastPassAt?.toISOString() ?? null };
}

/**
 * Start the drain. Called once from server.ts.
 *
 * `unref()` so the timer never holds the process open — a container told to stop must be able to.
 * `running` guards against a slow pass overlapping the next tick.
 */
export function startQboWebhookDrain(intervalMs = DRAIN_INTERVAL_MS): void {
  if (timer) return;
  // No database configured means no deployment to drain — a local `npm run dev` without
  // DATABASE_URL would otherwise log a Prisma error every tick.
  if (!process.env.DATABASE_URL) {
    logger.info("QBO webhook drain not started: no DATABASE_URL");
    return;
  }
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      // Watchdog. `running` is what stops two passes overlapping, so a pass that never settles
      // would pin it true and silently stop the drain forever — indistinguishable from "nothing
      // changed in QuickBooks". Abandoning the pass is safe: its rows keep their claim and the
      // stale reclaim returns them, which is the same path a killed container takes.
      await Promise.race([
        drainQboWebhookEvents(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("drain pass exceeded its watchdog")), CLAIM_STALE_MS)
        ),
      ]);
    } catch (e) {
      // Never let a bad pass kill the interval — the next one re-claims whatever was left.
      logger.error("QBO webhook drain pass threw", {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      running = false;
      lastPassAt = new Date();
    }
  }, intervalMs);
  timer.unref();

  // A pass in flight when the container is told to stop would otherwise hold its claim for the
  // full staleness window. Releasing it turns a ten-minute stall into an immediate handoff.
  const release = async () => {
    stopQboWebhookDrain();
    await prisma.qboWebhookEvent
      .updateMany({
        where: { status: "running" },
        data: { status: "queued", claimToken: null, claimedAt: null },
      })
      .catch(() => undefined);
  };
  process.once("SIGTERM", release);
  process.once("SIGINT", release);

  logger.info("QBO webhook drain started", { intervalMs });
}

export function stopQboWebhookDrain(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
