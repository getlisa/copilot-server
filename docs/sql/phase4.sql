-- Phase 4 — QuickBooks webhooks: the event ledger.
--
-- WHAT THIS IS FOR. Nothing flowed QuickBooks -> CLARA (gap #10 / T-29). Reference data only
-- refreshed when an admin clicked Sync, and an estimate edited or deleted inside QuickBooks never
-- reached us at all. The webhook endpoint POST /api/v1/webhooks/qbo now receives Intuit's
-- CloudEvents; this table is where a verified event lands.
--
-- It is BOTH a dedup ledger and a status trail. `event_id` UNIQUE is the whole dedup guarantee:
-- Intuit redelivers on any non-2xx and repeats the CloudEvents `id` verbatim, so the insert is
-- what makes a redelivery a no-op. The status columns answer "which tenants are failing", which
-- is the question a queue and its dead-letter queue cannot.
--
-- OWNERSHIP: this creates a NEW table, so it is owned by whatever role runs it — `app_user`, via
-- the service's own task definition. NO RDS master credentials, unlike phases 1b/2/3, which
-- touched `postgres`-owned tables. apply-phase4.sh therefore registers no credentialed revision.
--
-- ORDER: **this DDL runs BEFORE the image that uses it.** Prisma SELECTs every scalar column it
-- knows about, so the moment the webhook image deploys it asks for these columns on every read of
-- the model. The runbook's old "new nullable columns are safe to add after a deploy" line is
-- wrong for Prisma and has been corrected. A new TABLE is the same rule: deploy first and every
-- drain pass throws "relation does not exist".
--
-- Verified against `prisma migrate diff --from-empty --to-schema-datamodel` on 2026-09-09 —
-- every column, type and index name below is Prisma's own output, not hand-written guesses.
--
-- Idempotent: safe to re-run. There is no migration ledger in this project (merged is NOT
-- applied), so probe `information_schema` before assuming, and verify afterwards AS `app_user`.

CREATE TABLE IF NOT EXISTS "public"."qbo_webhook_events" (
    "id" BIGSERIAL NOT NULL,
    -- CloudEvents `id`. THE dedup key.
    "event_id" TEXT NOT NULL,
    -- `intuitaccountid`. Resolved to companies at drain time, not on receipt: one realm can
    -- legitimately be connected to more than one company, and the receiver must stay fast.
    "realm_id" TEXT NOT NULL,
    -- Which keyset's verifier token matched, "sandbox" | "production". The endpoint is registered
    -- on BOTH keysets at one URL, and nothing in the CloudEvent itself identifies which sent it.
    "keyset" TEXT,
    -- Lowercased entity segment of `type`; NULL when it is not one we subscribed to.
    "entity" TEXT,
    -- Operation segment, kept verbatim. Never constrained to an enum: Intuit's vocabulary is not
    -- fully documented, every operation is subscribed, and an unknown one is treated as "refetch".
    "operation" TEXT NOT NULL,
    "entity_id" TEXT,
    "event_time" TIMESTAMPTZ(6),
    -- The untouched CloudEvent, so debugging, replay and audit survive a lossy projection.
    "raw" JSONB NOT NULL,
    -- queued | running | done | skipped | failed. Deliberately TEXT, not an enum: a Postgres enum
    -- cannot take a new value without a migration, and this vocabulary is ours to extend.
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    -- When the row may next be attempted. Backed off on every requeue, so a stuck tenant cannot
    -- occupy every drain pass and five attempts span hours rather than ~50 seconds -- long enough
    -- to outlast a QuickBooks throttle window. NULL means "eligible now".
    "next_attempt_at" TIMESTAMPTZ(6),
    -- Companies that already completed this event. One realm can serve several companies, and
    -- without this a permanently broken sibling requeues the row forever, re-running the healthy
    -- company's full mirror pull on every pass.
    "done_companies" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "claimed_at" TIMESTAMPTZ(6),
    -- Identifies the drain pass that owns the row. A count alone cannot say WHICH rows a batch
    -- claim won when two passes overlap on part of the same id list.
    "claim_token" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "qbo_webhook_events_pkey" PRIMARY KEY ("id")
);

-- The dedup key. Without it Intuit's redelivery does the work twice.
CREATE UNIQUE INDEX IF NOT EXISTS "qbo_webhook_events_event_id_key"
    ON "public"."qbo_webhook_events"("event_id");

-- The drain's own query: eligible queued rows, oldest first.
CREATE INDEX IF NOT EXISTS "qbo_webhook_events_drain_idx"
    ON "public"."qbo_webhook_events"("status", "next_attempt_at", "created_at");

-- Ops: "what has this realm sent us lately", the question that diagnoses a tenant.
CREATE INDEX IF NOT EXISTS "qbo_webhook_events_realm_idx"
    ON "public"."qbo_webhook_events"("realm_id", "created_at" DESC);

-- `qbo_connections.realm_id` carries no index, and the drain resolves realm -> companies on it
-- every pass. Deliberately NOT unique: one realm may legitimately serve several companies, and
-- that fan-out is the design. This is the one statement here that touches an EXISTING table --
-- purely additive, and `qbo_connections` is app_user-owned like the rest of the QBO tables.
CREATE INDEX IF NOT EXISTS "qbo_connections_realm_id_idx"
    ON "public"."qbo_connections"("realm_id");

-- Assert rather than trust the DDL ran: a silent failure here surfaces as a drain that never
-- finds work, which looks exactly like "QuickBooks sent nothing".
DO $$
DECLARE
  cols     integer;
  idx      integer;
  conn_idx integer;
BEGIN
  SELECT count(*) INTO cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'qbo_webhook_events';
  IF cols <> 18 THEN
    RAISE EXCEPTION 'qbo_webhook_events has % columns, expected 18', cols;
  END IF;

  SELECT count(*) INTO idx FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'qbo_webhook_events';
  -- Exact, not `< 4`: the message claims an exact expectation, and a drifted or stray index is
  -- as much a signal as a missing one.
  IF idx <> 4 THEN
    RAISE EXCEPTION 'qbo_webhook_events has % indexes, expected 4 (pkey + 3)', idx;
  END IF;

  SELECT count(*) INTO conn_idx FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'qbo_connections_realm_id_idx';
  IF conn_idx <> 1 THEN
    RAISE EXCEPTION 'qbo_connections_realm_id_idx missing -- the drain would seq-scan every pass';
  END IF;

  RAISE NOTICE 'PHASE4_APPLIED: qbo_webhook_events, % columns, % indexes, realm index ok', cols, idx;
END $$;
