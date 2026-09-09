import { randomUUID } from "crypto";
import prisma from "./prisma";
import logger from "./logger";
import { qboConnected } from "./qbo";
import { runQboSync, QboSyncBusyError, type QboSyncStage } from "./qboIngest";
import { STAGE_FOR_ENTITY, type ParsedQboEvent, type QboEntity } from "./qboWebhook";

/**
 * Drains `qbo_webhook_events` — the processing half of the QuickBooks webhook feature.
 *
 * The receiver (api/controllers/webhook.controller) verifies, records and answers 200 in
 * milliseconds. Everything expensive happens here: a webhook's `data` is EMPTY, so acting on one
 * always costs a QuickBooks API read.
 *
 * WHY A LOOP AND NOT A QUEUE — see the `QboWebhookEvent` model comment. Short version: this
 * service has one ECS task, no queue and no worker, and a table already tracks what SQS would.
 *
 * THE DRAIN INTERVAL IS THE DEBOUNCE. Every event in a pass is grouped by (company, stage) and
 * the stage runs ONCE, so a bulk edit touching ten customers costs one refresh, not ten. That
 * falls out of batching rather than needing a timer of its own.
 */

/** How often the drain wakes. Also, therefore, the coalescing window. */
const DRAIN_INTERVAL_MS = 10_000;
/** Rows per pass. A ceiling on how much one company's burst can delay everybody else's. */
const BATCH_SIZE = 200;
/** A row claimed and never settled is returned to the queue after this — a killed task must not
 *  wedge an event forever. Comfortably above the slowest full sync. */
const CLAIM_STALE_MS = 10 * 60 * 1000;
/** After this many real failures a row stops retrying and stays visible as `failed`. */
const MAX_ATTEMPTS = 5;

/**
 * Record a verified delivery. Returns how many rows were NEW.
 *
 * `skipDuplicates` on the unique `event_id` IS the dedup: Intuit redelivers on any non-2xx and
 * repeats the CloudEvents `id` verbatim, so a redelivery inserts nothing and the drain never sees
 * it twice. One statement, because the receiver has to stay fast.
 */
export async function recordQboWebhookEvents(
  events: ParsedQboEvent[],
  keyset: string
): Promise<number> {
  if (events.length === 0) return 0;
  const { count } = await prisma.qboWebhookEvent.createMany({
    data: events.map((e) => ({
      eventId: e.eventId,
      realmId: e.realmId,
      keyset,
      entity: e.entity,
      operation: e.operation,
      entityId: e.entityId,
      // An unparseable timestamp must not reject the event; the CloudEvent itself is kept in raw.
      eventTime: e.eventTime && !Number.isNaN(Date.parse(e.eventTime)) ? new Date(e.eventTime) : null,
      raw: e.raw as object,
      // An entity we do not subscribe to is recorded for visibility and settled immediately.
      // Never an error: one tenant's unexpected event must not put a shared endpoint at risk.
      status: e.entity ? "queued" : "skipped",
    })),
    skipDuplicates: true,
  });
  return count;
}

/**
 * Every company connected to this realm, right now.
 *
 * DELIBERATELY A FAN-OUT, NOT A UNIQUE KEY. collection_agent_backend hit the same ambiguity —
 * `realmid` with no constraint — and fixed it with a partial unique index, because there a wrong
 * answer meant its dialer calling people on behalf of an abandoned tenant. Here the consequence
 * of two companies sharing a realm is one extra API read and a second mirror being correctly
 * refreshed. And the sandbox realm plausibly IS attached to more than one company row already, so
 * a unique index would either fail to build or silently deactivate a connection someone is using.
 *
 * `qboConnected` is what keeps this honest: it requires tokens, a realm, AND that the row was
 * minted by the keyset this server runs. That excludes exactly the stale-tenant case the index
 * was invented for.
 */
async function companiesForRealm(realmId: string): Promise<number[]> {
  const rows = await prisma.qboConnection.findMany({ where: { realmId } });
  return rows.filter((r) => qboConnected(r)).map((r) => r.companyId);
}

/** An estimate deleted in QuickBooks. Uses only columns that already exist. */
async function handleEstimateEvent(
  companyId: number,
  operation: string,
  entityId: string | null
): Promise<"done" | "skipped"> {
  // Detecting an EDIT made inside QuickBooks needs a stored SyncToken, and that column does not
  // exist yet (it lands with the phase-5 DDL on `quotes`, which is postgres-owned and needs the
  // RDS master credentials). Until then a non-delete estimate event is recorded and skipped — and
  // its `operation` in the ledger is the point: it is how we learn Intuit's actual vocabulary for
  // this entity, which no documentation states.
  if (!/^delete/.test(operation)) return "skipped";
  if (!entityId) return "skipped";

  // Clearing the id stops the completed-quote badge pointing into a file that no longer holds the
  // estimate (gap #9). The post path already creates a fresh estimate when the stored id is
  // dangling, so this changes what the UI claims, not what a re-completion does.
  const { count } = await prisma.quote.updateMany({
    where: { companyId, qboEstimateId: entityId },
    // `qboSyncedAt` goes with it. Leaving it set would have the card say "synced at <time>" about
    // an estimate that no longer exists — a different lie from the one we are fixing.
    data: { qboEstimateId: null, qboSyncedAt: null },
  });
  if (count > 0)
    logger.info("QBO estimate deleted in QuickBooks; cleared the stored id", {
      companyId,
      qboEstimateId: entityId,
      quotes: count,
    });
  return "done";
}

/**
 * One drain pass. Returns what it settled, so the check script and the loop can both report.
 *
 * Safe to call concurrently: rows are claimed with a token, and a pass only ever touches rows
 * carrying its own.
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

  const queued = await prisma.qboWebhookEvent.findMany({
    where: { status: "queued" },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
    select: { id: true },
  });
  if (queued.length === 0) return empty;

  // Claim by token, not by count. A count alone cannot say WHICH rows this pass won when two
  // passes overlap on part of the same id list — and `status: "queued"` in the predicate is what
  // makes the claim atomic against the other pass.
  const claimToken = randomUUID();
  await prisma.qboWebhookEvent.updateMany({
    where: { id: { in: queued.map((r) => r.id) }, status: "queued" },
    data: { status: "running", claimedAt: new Date(), claimToken },
  });
  const rows = await prisma.qboWebhookEvent.findMany({ where: { claimToken } });
  if (rows.length === 0) return empty;

  const result = { ...empty, claimed: rows.length };

  /**
   * Outcomes are COLLECTED and each row settled exactly once at the end.
   *
   * One realm can fan out to several companies (see `companiesForRealm`), so a single event is
   * processed once per company. Settling inside that loop would let the second company's write
   * overwrite the first's: company A succeeding and company B failing would put the row back to
   * `queued`, and the next pass would re-sync A for nothing. It would also double-count.
   *
   * Precedence: anything needing a retry wins over `done`, which wins over `skipped` — the row
   * must come back if ANY company still owes work on it.
   */
  type Outcome = "done" | "skipped" | "failed" | "queued";
  const RANK: Record<Outcome, number> = { skipped: 0, done: 1, failed: 2, queued: 3 };
  const outcomes = new Map<bigint, { status: Outcome; error?: string; attempts?: number }>();
  const record = (id: bigint, status: Outcome, error?: string, attempts?: number) => {
    const prev = outcomes.get(id);
    if (prev && RANK[prev.status] >= RANK[status]) return;
    outcomes.set(id, { status, error, attempts });
  };

  // Resolve each realm once, however many events it sent.
  const realms = [...new Set(rows.map((r) => r.realmId))];
  const companiesByRealm = new Map<string, number[]>();
  for (const realm of realms) companiesByRealm.set(realm, await companiesForRealm(realm));

  const unroutable = rows.filter((r) => (companiesByRealm.get(r.realmId) ?? []).length === 0);
  if (unroutable.length > 0) {
    // Not an error. An unknown realm, or one whose only connection was minted by the other
    // keyset — which is every production delivery while this server runs sandbox.
    logger.info("QBO webhook events not routable to a connected company", {
      realms: [...new Set(unroutable.map((r) => r.realmId))],
      events: unroutable.length,
    });
    for (const row of unroutable) record(row.id, "skipped");
  }

  // (company, event) pairs — one realm can fan out to several companies, and each needs its own
  // refresh against its own tokens.
  const routable = rows.filter((r) => (companiesByRealm.get(r.realmId) ?? []).length > 0);
  const byCompany = new Map<number, typeof rows>();
  for (const row of routable)
    for (const companyId of companiesByRealm.get(row.realmId) ?? [])
      byCompany.set(companyId, [...(byCompany.get(companyId) ?? []), row]);

  for (const [companyId, companyRows] of byCompany) {
    // Estimates have no ingest stage; they are handled per event.
    const estimateRows = companyRows.filter((r) => r.entity === "estimate");
    const stageRows = companyRows.filter((r) => r.entity && r.entity !== "estimate");

    const stages = [
      ...new Set(
        stageRows
          .map((r) => STAGE_FOR_ENTITY[r.entity as QboEntity])
          .filter((s): s is string => !!s)
      ),
    ] as QboSyncStage[];

    if (stages.length > 0) {
      try {
        // Tax also re-reads Preferences.TaxPrefs — see STAGE_FOR_ENTITY. `markComplete: false`
        // keeps `lastSyncAt` meaning "last COMPLETE sync"; a partial refresh must not claim it.
        const wanted = stages.includes("salesTax")
          ? ([...new Set([...stages, "taxPrefs"])] as QboSyncStage[])
          : stages;
        await runQboSync(companyId, wanted, { markComplete: false });
        for (const row of stageRows) record(row.id, "done");
      } catch (e) {
        if (e instanceof QboSyncBusyError) {
          // RE-QUEUE, never skip. The running sync will finish, but it may have started before
          // the change that triggered us, so dropping the event would lose the update. Attempts
          // are deliberately not bumped: waiting for a lock is not a failure.
          for (const row of stageRows) record(row.id, "queued");
        } else {
          const message = e instanceof Error ? e.message : String(e);
          logger.error("QBO webhook stage refresh failed", { companyId, stages, error: message });
          for (const row of stageRows) {
            const attempts = row.attempts + 1;
            record(row.id, attempts >= MAX_ATTEMPTS ? "failed" : "queued", message, attempts);
          }
        }
      }
    }

    for (const row of estimateRows) {
      try {
        record(row.id, await handleEstimateEvent(companyId, row.operation, row.entityId));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const attempts = row.attempts + 1;
        record(row.id, attempts >= MAX_ATTEMPTS ? "failed" : "queued", message, attempts);
      }
    }
  }

  for (const [id, o] of outcomes) {
    await prisma.qboWebhookEvent.update({
      where: { id },
      data: {
        status: o.status,
        claimToken: null,
        claimedAt: null,
        ...(o.attempts === undefined ? {} : { attempts: o.attempts }),
        ...(o.error === undefined ? {} : { lastError: o.error.slice(0, 1000) }),
      },
    });
    if (o.status === "queued") result.requeued += 1;
    else result[o.status] += 1;
  }

  logger.info("QBO webhook drain pass", result);
  return result;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Start the drain. Called once from server.ts.
 *
 * `unref()` so the timer never holds the process open — a container told to stop must be able to.
 * `running` guards against a slow pass overlapping the next tick, which would double every API
 * read for no benefit.
 */
export function startQboWebhookDrain(intervalMs = DRAIN_INTERVAL_MS): void {
  if (timer) return;
  // No database configured means no deployment to drain — a local `npm run dev` without
  // DATABASE_URL would otherwise log a Prisma error every tick, drowning whatever the developer
  // is actually working on. Deployed environments always have it.
  if (!process.env.DATABASE_URL) {
    logger.info("QBO webhook drain not started: no DATABASE_URL");
    return;
  }
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await drainQboWebhookEvents();
    } catch (e) {
      // Never let a bad pass kill the interval — the next one re-claims whatever was left.
      logger.error("QBO webhook drain pass threw", {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  logger.info("QBO webhook drain started", { intervalMs });
}

export function stopQboWebhookDrain(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
