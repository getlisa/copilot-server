-- Phase 9 — estimate drift detection: the SyncToken baseline on `quotes`.
--
-- WHAT THIS IS FOR. `estimate.deleted` already ships (phase 6, applied 2026-09-09) and clears the
-- badge that pointed into a file QuickBooks no longer holds. The other half of gap #10 / T-29 did
-- not: an estimate EDITED inside QuickBooks was indistinguishable from the echo of our own post,
-- so every non-delete estimate event was recorded and skipped.
--
-- QBO bumps an estimate's `SyncToken` on every change to it, whoever made the change, and the
-- CloudEvent itself says only that something happened — its `data` is empty. So the token is the
-- only thing that can separate the two, and separating them requires remembering what the token
-- was when WE last wrote. That is `qbo_sync_token`.
--
-- `qbo_remote_changed_at` is what the comparison produces: the moment a webhook first showed the
-- estimate had moved past our token. It matters because the update-in-place path (QBO PRD US6)
-- overwrites the estimate unconditionally on re-completion. Today that silently discards an edit
-- the client made in their own books; with this column the screen can warn first.
--
-- OWNERSHIP: needs the RDS master credentials. `quotes` is owned by `postgres`, not `app_user` —
-- the same wall phase 1b and phase 2 hit. This was flagged as a blocking dependency in
-- QBO-WEBHOOKS-PLAN.md §4 before the webhook work started, and it is still true.
--
-- ORDER: **this DDL runs BEFORE the image that uses it.** Prisma SELECTs every scalar column its
-- generated client knows about, so the moment the image carrying these fields deploys it asks for
-- both columns on EVERY read of `quotes` — that is every estimate list, every estimate open, and
-- the drain. Deploying first does not degrade the new feature; it takes the whole Estimator down
-- with "column does not exist". The runbook's old "new nullable columns are safe to add after a
-- deploy" line is wrong for Prisma and was corrected once already, at phase 6.
--
-- BOTH COLUMNS ARE NULLABLE ON PURPOSE, and null is not a neutral default here — it is "unknown".
-- A quote that posted before this column existed has no baseline, and the drain adopts whatever
-- QuickBooks reports on the first event rather than calling the unknown a drift. A false "changed
-- in QuickBooks" warning teaches people to ignore the real one; the cost of the honest reading is
-- that an edit made before the baseline existed stays invisible.
--
-- NO BACKFILL. Reading the current SyncToken for every posted estimate would be one QuickBooks
-- API call per quote across every connected realm, to establish a baseline the next re-completion
-- or the next webhook establishes for free. Not worth the rate limit.
--
-- Verified against `prisma migrate diff --from-empty --to-schema-datamodel` on 2026-09-11 — the
-- column names and types below are Prisma's own output ("qbo_sync_token" TEXT,
-- "qbo_remote_changed_at" TIMESTAMP(3)), not hand-written guesses.
--
-- NUMBERED 9. phase7 (zt_connections) and phase8 (ZenTrades write-back) are already filed, and
-- both sit in docs/sql/prod-catchup-2026-09-10.sql. A migration numbered below an already-staged
-- one reads as "should have run first", which is the one thing a sequence number exists to say.
--
-- Idempotent: safe to re-run. There is no migration ledger in this project (merged is NOT
-- applied), so probe `information_schema` before assuming, and verify afterwards AS `app_user`.

-- ---- 1. the two columns -----------------------------------------------------------------------

ALTER TABLE "public"."quotes"
    ADD COLUMN IF NOT EXISTS "qbo_sync_token" TEXT;

ALTER TABLE "public"."quotes"
    ADD COLUMN IF NOT EXISTS "qbo_remote_changed_at" TIMESTAMP(3);

-- ---- 2. grants --------------------------------------------------------------------------------
-- The service reads and writes as `app_user`. Column-level privileges are NOT inherited by columns
-- added after a table-level GRANT in every path (an ALTER ... ADD COLUMN inherits the table grant,
-- but a re-run against a database where someone once granted per-column would not), so the
-- table-level grant is re-asserted. Cheap, idempotent, and removes the question.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."quotes" TO app_user;

-- ---- 3. loud verification ---------------------------------------------------------------------
-- Merged is not applied and applied is not verified. This fails the run if either column is
-- missing, rather than letting a half-applied migration read as success.

DO $$
DECLARE
    n integer;
BEGIN
    SELECT count(*) INTO n
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'quotes'
      AND column_name IN ('qbo_sync_token', 'qbo_remote_changed_at');

    IF n <> 2 THEN
        RAISE EXCEPTION 'PHASE9 FAILED: expected 2 new columns on public.quotes, found %', n;
    END IF;

    RAISE NOTICE 'PHASE9_APPLIED: qbo_sync_token + qbo_remote_changed_at present on public.quotes';
END
$$;
