-- ============================================================================
-- PROD CATCH-UP 2026-09-10 — everything pending since the 2026-09-07 apply,
-- in dependency order. One file for one CloudShell run (docs/CLOUDSHELL_PROD_SQL.md).
--
--   1. customers / sales tax as ENTITIES (runbook 2026-09-08, expand phase ONLY)
--   2. phase1b — tax snapshot on quotes, sub-customers, address, qbo sync cols
--   3. phase3  — customers key -> UNIQUE NULLS NOT DISTINCT (company, parent, name)
--   4. phase4  — proposal template library (+ per-company 'Default' data migration)
--   5. zt_connections            (now filed as docs/sql/phase7.sql)
--   6. ZenTrades sync/write-back (now filed as docs/sql/phase8.sql)
--   7. ownership + grants for the new tables, and a loud final verification
--
-- NOT INCLUDED, ON PURPOSE: the CONTRACT phase (docs/sql/phase2.sql — drops
-- quotes.qbo_customer_id/qbo_customer_name and the superseded raw_* tables).
-- It runs ONLY after the new image is deployed and exercised; running it now
-- takes down the CURRENT image's quote reads. See the runbook's point-of-no-return note.
--
-- Idempotent throughout — a re-run after a mid-file failure is safe.
-- Run as the Aurora MASTER user (app_user cannot DDL):
--   psql "host=<WRITER> dbname=<DB> user=<MASTER_USER> password=<PW> sslmode=require" \
--     -v ON_ERROR_STOP=1 -f prod-catchup-2026-09-10.sql
--
-- ORDER RULE: this runs BEFORE the image that reads these columns deploys.
-- ============================================================================


-- ============================================================================
-- 1. customers + sales tax as entities (expand)
-- ============================================================================

-- Every service-managed table gets the same audit set (architecture, 2026-09-08):
-- is_active (reversible "not in use"), is_deleted (soft delete, so history that points at the
-- row survives), created_at/created_by, updated_at/updated_by. created_by/updated_by are
-- users.id and NULLABLE: ingestion and background work have no acting user to attribute.
CREATE TABLE IF NOT EXISTS public.customers (
  id         SERIAL PRIMARY KEY,
  company_id INT     NOT NULL,
  name       TEXT    NOT NULL,
  email      TEXT,
  phone      TEXT,
  address    TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by BIGINT,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by BIGINT
);
-- Mirrors QuickBooks' own DisplayName uniqueness, so a name that works here cannot fail there
-- for a reason the technician never saw.
CREATE UNIQUE INDEX IF NOT EXISTS customers_company_id_name_key ON public.customers (company_id, name);

CREATE TABLE IF NOT EXISTS public.customer_qb (
  id           SERIAL PRIMARY KEY,
  customer_id  INT  NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  company_id   INT  NOT NULL,
  realm_id     TEXT NOT NULL,
  qbo_id       TEXT NOT NULL,
  display_name TEXT NOT NULL,
  -- Read-only in QuickBooks: the parent chain joined by colons ("Customer:Job:Sub-job"). It is
  -- what distinguishes two jobs sharing a name under different parents.
  fully_qualified_name TEXT,
  raw          JSONB,
  synced_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by   BIGINT,
  updated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by   BIGINT
);
-- One row per customer per realm: reconnect to a different QuickBooks file and the old row stays
-- inert rather than being overwritten with an id belonging to someone else's books.
CREATE UNIQUE INDEX IF NOT EXISTS customer_qb_customer_id_realm_id_key ON public.customer_qb (customer_id, realm_id);
CREATE UNIQUE INDEX IF NOT EXISTS customer_qb_company_id_realm_id_qbo_id_key ON public.customer_qb (company_id, realm_id, qbo_id);
CREATE INDEX IF NOT EXISTS customer_qb_company_id_realm_id_idx ON public.customer_qb (company_id, realm_id);

CREATE TABLE IF NOT EXISTS public.sales_tax (
  id           SERIAL PRIMARY KEY,
  company_id   INT     NOT NULL,
  name         TEXT    NOT NULL,
  -- "MANUAL" (typed in tax settings) or "QBO" (ingested). Drives the source-of-truth rule: a
  -- company connected to QuickBooks or a CRM takes its tax from that system, so it cannot
  -- create MANUAL rates and cannot use ones created before connecting. Kept, not deleted —
  -- disconnecting restores them, which a delete could not undo.
  source       TEXT    NOT NULL DEFAULT 'MANUAL',
  rate_percent DECIMAL(6,4) NOT NULL,
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by   BIGINT,
  updated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by   BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_tax_company_id_name_key ON public.sales_tax (company_id, name);
CREATE INDEX IF NOT EXISTS sales_tax_company_id_is_active_idx ON public.sales_tax (company_id, is_active);
-- At most ONE default per company. Partial unique indexes cannot be expressed in schema.prisma,
-- so this is the only place the rule is enforced by the database — the controller also moves the
-- default inside a transaction. Two defaults would mean a new estimate picking one arbitrarily,
-- and picking arbitrarily in money.
CREATE UNIQUE INDEX IF NOT EXISTS sales_tax_one_default_per_company
  ON public.sales_tax (company_id) WHERE is_default AND NOT is_deleted;

CREATE TABLE IF NOT EXISTS public.sales_tax_qb (
  id           SERIAL PRIMARY KEY,
  sales_tax_id INT  NOT NULL REFERENCES public.sales_tax(id) ON DELETE CASCADE,
  company_id   INT  NOT NULL,
  realm_id     TEXT NOT NULL,
  -- "TaxRate" carries the percentage; "TaxCode" is what a transaction line references. Intuit
  -- models them separately, so one CLARA rate can hold a row of each.
  qbo_type     TEXT NOT NULL,
  qbo_id       TEXT NOT NULL,
  name         TEXT NOT NULL,
  raw          JSONB,
  synced_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by   BIGINT,
  updated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by   BIGINT
);
-- salesTaxId is part of the key on purpose: one QuickBooks rate belongs to MANY codes (a state
-- rate sits in every city group in that state), so a key without it makes the second code's
-- member insert collide with the first's row and abort the entire sync.
-- Name copied verbatim from `prisma migrate diff` — Prisma truncates the derived name to
-- Postgres's 63-byte limit (note the double underscore), and a divergence here is permanent
-- drift in a repo whose only record of production is schema.prisma.
CREATE UNIQUE INDEX IF NOT EXISTS sales_tax_qb_sales_tax_id_company_id_realm_id_qbo_type_qbo__key
  ON public.sales_tax_qb (sales_tax_id, company_id, realm_id, qbo_type, qbo_id);
CREATE INDEX IF NOT EXISTS sales_tax_qb_sales_tax_id_idx ON public.sales_tax_qb (sales_tax_id);

-- Quotes point at the customer ENTITY. The QuickBooks id is not duplicated here — it lives on
-- customer_qb, keyed by realm, so a reconnect cannot leave a stale id attached to an estimate.
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS customer_id INT;
-- The FK schema.prisma already implies (Quote.customer is an optional relation). Safe here
-- because every existing row is NULL, and SET NULL rather than CASCADE: deleting a customer
-- must not delete quotes.
ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS quotes_customer_id_fkey;
ALTER TABLE public.quotes ADD CONSTRAINT quotes_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

-- NO BACKFILL, deliberately (product, 2026-09-08). Older estimates are not synced: a company
-- with no integration has nothing to carry across, and a company with one gets a per-estimate
-- "Sync to QuickBooks" action beside Send / Download rather than a bulk migration of history.
--
-- The failure this used to guard against is closed in code instead: ensureQboCustomer's legacy
-- branch now REFUSES a quote with no customer name, where it previously created a QuickBooks
-- customer literally called "Customer" in the client's books. Measured 2026-09-08: 0 of 99
-- quotes carry qbo_customer_id and 0 have been posted, so nothing is being abandoned here.

ALTER TABLE public.customers    OWNER TO app_user;
ALTER TABLE public.customer_qb  OWNER TO app_user;
ALTER TABLE public.sales_tax    OWNER TO app_user;
ALTER TABLE public.sales_tax_qb OWNER TO app_user;
GRANT USAGE ON SEQUENCE public.customers_id_seq    TO app_user;
GRANT USAGE ON SEQUENCE public.customer_qb_id_seq  TO app_user;
GRANT USAGE ON SEQUENCE public.sales_tax_id_seq    TO app_user;
GRANT USAGE ON SEQUENCE public.sales_tax_qb_id_seq TO app_user;

-- ============================================================================
-- 2. phase1b — tax snapshot / sub-customers / address
-- ============================================================================

-- ============================================================================
-- QBO Phase 1b (expand) — tax on estimates, sub-customers, structured address
--
-- ORDER MATTERS: this block runs BEFORE the image that uses it ships.
-- Prisma SELECTs every scalar column it knows about, so the moment the new
-- client is deployed it asks for quote_line_items.taxable on every quote read.
-- Running the DDL afterwards means every estimate screen 500s in between.
-- (The runbook's "new nullable columns are safe to add after deploy" line is
-- wrong for Prisma and is corrected in the same PR as this file.)
--
-- Every statement is additive and IF NOT EXISTS, so a partial run is safe to
-- repeat. Nothing here drops or rewrites an existing column.
-- Names are copied verbatim from:
--   npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
-- ============================================================================

-- ---------- customers: sub-customer parent + structured address ----------
ALTER TABLE "public"."customers" ADD COLUMN IF NOT EXISTS "parent_id" INTEGER;
ALTER TABLE "public"."customers" ADD COLUMN IF NOT EXISTS "address_line1" TEXT;
ALTER TABLE "public"."customers" ADD COLUMN IF NOT EXISTS "address_line2" TEXT;
ALTER TABLE "public"."customers" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "public"."customers" ADD COLUMN IF NOT EXISTS "state" TEXT;
ALTER TABLE "public"."customers" ADD COLUMN IF NOT EXISTS "postal_code" TEXT;
ALTER TABLE "public"."customers" ADD COLUMN IF NOT EXISTS "country" TEXT;

DO $$ BEGIN
  ALTER TABLE "public"."customers"
    ADD CONSTRAINT "customers_parent_id_fkey"
    FOREIGN KEY ("parent_id") REFERENCES "public"."customers"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A row cannot be its own parent. The column is self-referential and no
-- re-parenting path exists yet, so this is a backstop against the day one does.
DO $$ BEGIN
  ALTER TABLE "public"."customers"
    ADD CONSTRAINT "customers_parent_not_self" CHECK ("parent_id" IS DISTINCT FROM "id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "customers_parent_id_idx" ON "public"."customers"("parent_id");

-- ---------- quotes: the sales-tax snapshot ----------
ALTER TABLE "public"."quotes" ADD COLUMN IF NOT EXISTS "sales_tax_id" INTEGER;
ALTER TABLE "public"."quotes" ADD COLUMN IF NOT EXISTS "tax_rate_percent" DECIMAL(6,4);
ALTER TABLE "public"."quotes" ADD COLUMN IF NOT EXISTS "tax_exempt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "public"."quotes" ADD COLUMN IF NOT EXISTS "qbo_synced_at" TIMESTAMP(3);
ALTER TABLE "public"."quotes" ADD COLUMN IF NOT EXISTS "qbo_sync_error" TEXT;

-- RESTRICT, not SET NULL: rates are only ever soft-deleted, so this never fires
-- in normal operation. If one were hard-deleted, SET NULL would clear the id and
-- leave the percentage behind — an estimate quoting a rate that belongs to
-- nothing, and a violation of the pairing CHECK below.
DO $$ BEGIN
  ALTER TABLE "public"."quotes"
    ADD CONSTRAINT "quotes_sales_tax_id_fkey"
    FOREIGN KEY ("sales_tax_id") REFERENCES "public"."sales_tax"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The two snapshot columns move together or not at all. Prisma cannot express
-- this, and a half-set pair is the shape that renders tax on the document while
-- the QuickBooks post finds no code to declare — or the reverse.
DO $$ BEGIN
  ALTER TABLE "public"."quotes"
    ADD CONSTRAINT "quotes_tax_snapshot_paired"
    CHECK (("sales_tax_id" IS NULL) = ("tax_rate_percent" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "quotes_sales_tax_id_idx" ON "public"."quotes"("sales_tax_id");

-- ---------- quote_line_items: per-line taxability ----------
-- Defaults true (materials are the common case); labor lines are seeded false at
-- creation, matching the "Taxed" column the estimate PDF has always printed.
ALTER TABLE "public"."quote_line_items" ADD COLUMN IF NOT EXISTS "taxable" BOOLEAN NOT NULL DEFAULT true;

-- ---------- qbo_connections: sync state and the realm's tax mode ----------
ALTER TABLE "public"."qbo_connections" ADD COLUMN IF NOT EXISTS "last_sync_at" TIMESTAMP(3);
ALTER TABLE "public"."qbo_connections" ADD COLUMN IF NOT EXISTS "last_sync_error" TEXT;
ALTER TABLE "public"."qbo_connections" ADD COLUMN IF NOT EXISTS "sync_started_at" TIMESTAMP(3);
ALTER TABLE "public"."qbo_connections" ADD COLUMN IF NOT EXISTS "using_sales_tax" BOOLEAN;
ALTER TABLE "public"."qbo_connections" ADD COLUMN IF NOT EXISTS "partner_tax_enabled" BOOLEAN;

-- ---------- verification ----------
-- Fails loudly rather than reporting a partial apply as a success.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(x, ', ') INTO missing FROM (
    SELECT 'customers.' || c FROM unnest(ARRAY[
      'parent_id','address_line1','address_line2','city','state','postal_code','country'
    ]) c WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='customers' AND column_name=c)
    UNION ALL
    SELECT 'quotes.' || c FROM unnest(ARRAY[
      'sales_tax_id','tax_rate_percent','tax_exempt','qbo_synced_at','qbo_sync_error'
    ]) c WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='quotes' AND column_name=c)
    UNION ALL
    SELECT 'quote_line_items.taxable' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='quote_line_items' AND column_name='taxable')
    UNION ALL
    SELECT 'qbo_connections.' || c FROM unnest(ARRAY[
      'last_sync_at','last_sync_error','sync_started_at','using_sales_tax','partner_tax_enabled'
    ]) c WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='qbo_connections' AND column_name=c)
  ) t(x);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'PHASE1B INCOMPLETE — missing: %', missing;
  END IF;
  RAISE NOTICE 'PHASE1B_APPLIED';
END $$;


-- ============================================================================
-- 3. phase3 — customers key swap (NULLS NOT DISTINCT)
-- ============================================================================

-- ============================================================================
-- QBO Phase 3 — the customer name key was too strict
--
-- `customers` was unique on (company_id, name), on the premise that QuickBooks'
-- DisplayName is unique across the whole realm. A sandbox probe settled it on
-- 2026-09-08 and the premise was WRONG: Intuit accepted
--
--     Mark Cho:Building 1
--
-- while "Mahee Zentrades:Building 1" already existed. DisplayName is SIBLING-unique,
-- not realm-unique. So the old key refused customers QuickBooks would take — a
-- technician adding "Building 1" to a second property was told it already existed,
-- when it is a different building on a different site.
--
-- NULLS NOT DISTINCT is the load-bearing half. Every root customer has parent_id
-- NULL, and Postgres treats NULLs as distinct by default — so a plain
-- UNIQUE (company_id, parent_id, name) would allow two top-level "Acme"s and lose
-- the guarantee exactly where it matters most. Requires Postgres 15+; production is
-- 17.6. Prisma cannot express this, so schema.prisma declares the columns and a
-- comment records the divergence, the same way `sales_tax_one_default_per_company`
-- already does.
--
-- Verified before running: zero (company_id, parent_id, name) collisions in the
-- existing data, and zero names carrying the "(qboId)" suffix the old key forced.
--
-- Safe in either deploy order — it only ever ACCEPTS more rows than before — but it
-- is grouped with the code that stops sending the narrower key.
-- ============================================================================

DO $$ BEGIN
  ALTER TABLE "public"."customers"
    ADD CONSTRAINT "customers_company_id_parent_id_name_key"
    UNIQUE NULLS NOT DISTINCT ("company_id", "parent_id", "name");
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

-- Dropped only after the replacement exists, so there is no window in which a
-- duplicate name could be inserted.
ALTER TABLE "public"."customers" DROP CONSTRAINT IF EXISTS "customers_company_id_name_key";
DROP INDEX IF EXISTS "public"."customers_company_id_name_key";

-- ---------- verification ----------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='customers'
       AND indexname='customers_company_id_parent_id_name_key'
  ) THEN
    RAISE EXCEPTION 'PHASE3 — the new key was not created';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='customers'
       AND indexname='customers_company_id_name_key'
  ) THEN
    RAISE EXCEPTION 'PHASE3 — the old key is still present';
  END IF;

  -- The whole point: NULLS NOT DISTINCT must actually be on it, or two top-level
  -- customers could share a name and nothing would say so until a sync collided.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'customers_company_id_parent_id_name_key'
       AND i.indnullsnotdistinct
  ) THEN
    RAISE EXCEPTION 'PHASE3 — the new key is missing NULLS NOT DISTINCT';
  END IF;

  RAISE NOTICE 'PHASE3_APPLIED';
END $$;


-- ============================================================================
-- 4. phase4 — proposal template library
-- ============================================================================

-- Phase 4: proposal template library (ZenTrades plan, Feature B / Phase 1).
-- The single companies.proposal_template Json column becomes a per-company library of named
-- templates. Existing designs migrate as one row named 'Default'; the column is kept as a
-- read-fallback for one release, then dropped in a later phase.
--
-- Idempotent: safe to re-run. Runs via the runbook (docs/PROD_DB_MIGRATION_RUNBOOK.md) —
-- never prisma migrate/db push. DDL runs BEFORE the image that reads these columns.

CREATE TABLE IF NOT EXISTS public.proposal_templates (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        VARCHAR(120) NOT NULL,
  blocks      JSONB NOT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_proposal_templates_company
  ON public.proposal_templates(company_id);

-- Exactly one default per company. Partial unique index: Prisma cannot express this, the
-- schema.prisma model comment records the divergence (same pattern as
-- sales_tax_one_default_per_company).
CREATE UNIQUE INDEX IF NOT EXISTS proposal_templates_one_default_per_company
  ON public.proposal_templates(company_id) WHERE is_default;

-- Migrate each company's existing single design to a 'Default' row. NOT EXISTS keeps a
-- re-run from duplicating; nobody's proposals change on launch day.
INSERT INTO public.proposal_templates (company_id, name, blocks, is_default)
SELECT c.id, 'Default', c.proposal_template, TRUE
FROM public.companies c
WHERE c.proposal_template IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.proposal_templates pt WHERE pt.company_id = c.id);

-- The chat's template choice + once-per-quote ask latch (mirrors labor_asked).
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS proposal_template_id INTEGER;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS template_asked BOOLEAN NOT NULL DEFAULT FALSE;


-- ============================================================================
-- 5. phase5 — zt_connections
-- ============================================================================

-- Phase 5: ZenTrades connection (ZenTrades plan 2.1/2.2 — connection only; sync comes later).
-- One row per company, the qbo_connections pattern. Idempotent; runs via the runbook or
-- docs/CLOUDSHELL_PROD_SQL.md — never prisma migrate/db push.
-- ORDER: run BEFORE the image that reads it deploys.

CREATE TABLE IF NOT EXISTS public.zt_connections (
  id                       SERIAL PRIMARY KEY,
  company_id               INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  encrypted_auth           TEXT,
  zt_company_id            VARCHAR(64),
  zt_company_name          VARCHAR(200),
  zt_user_id               VARCHAR(64),
  access_token_expires_at  TIMESTAMP(3),
  last_sync_at             TIMESTAMP(3),
  last_sync_error          TEXT,
  sync_started_at          TIMESTAMP(3),
  created_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================================
-- 6. phase6 — ZenTrades sync + write-back
-- ============================================================================


-- The enum predates ZenTrades (pricebook_items.source). Guarded so a prod that somehow
-- lacks it gets it created rather than failing the ALTER below. PG 17 allows ADD VALUE
-- inside a transaction; psql -f runs autocommit regardless.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'pricebook_source' AND n.nspname = 'public') THEN
    CREATE TYPE public.pricebook_source AS ENUM ('MANUAL', 'HOME_DEPOT', 'ZENTRADES');
  END IF;
END $$;

-- Phase 6: ZenTrades sync + write-back schema (plan items 3, 5-8).
-- Raw-ingest tables (collections-agent pattern), link tables (QBO _qb pattern), quote linkage
-- columns, pricebook source marker, and the re-login serialization lock.
-- Idempotent; runs via the runbook or docs/CLOUDSHELL_PROD_SQL.md — never prisma migrate.
-- ORDER: run BEFORE the image that reads it deploys (with or after phase5).

CREATE TABLE IF NOT EXISTS public.zt_jobs_raw (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL,
  zt_ticket_id   VARCHAR(64) NOT NULL,
  ticket_number  VARCHAR(64),
  zt_updated_at  TIMESTAMP(3),
  raw_payload    JSONB NOT NULL,
  content_hash   VARCHAR(64) NOT NULL,
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT zt_jobs_raw_company_ticket UNIQUE (company_id, zt_ticket_id)
);
CREATE INDEX IF NOT EXISTS idx_zt_jobs_raw_company_updated
  ON public.zt_jobs_raw(company_id, zt_updated_at DESC);

CREATE TABLE IF NOT EXISTS public.zt_deficiencies_raw (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL,
  zt_deficiency_id  VARCHAR(64) NOT NULL,
  zt_ticket_id      VARCHAR(64),
  status            VARCHAR(32),
  raw_payload       JSONB NOT NULL,
  content_hash      VARCHAR(64) NOT NULL,
  created_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT zt_deficiencies_raw_company_def UNIQUE (company_id, zt_deficiency_id)
);
CREATE INDEX IF NOT EXISTS idx_zt_deficiencies_raw_ticket
  ON public.zt_deficiencies_raw(company_id, zt_ticket_id);

CREATE TABLE IF NOT EXISTS public.zt_catalog_raw (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL,
  kind              VARCHAR(16) NOT NULL,
  zt_item_id        VARCHAR(64) NOT NULL,
  raw_payload       JSONB NOT NULL,
  content_hash      VARCHAR(64) NOT NULL,
  projected_item_id INTEGER,
  created_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT zt_catalog_raw_company_kind_item UNIQUE (company_id, kind, zt_item_id)
);

CREATE TABLE IF NOT EXISTS public.customer_zt (
  id              SERIAL PRIMARY KEY,
  customer_id     INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  company_id      INTEGER NOT NULL,
  zt_customer_id  VARCHAR(64) NOT NULL,
  raw             JSONB,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT customer_zt_company_ztid UNIQUE (company_id, zt_customer_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_zt_customer ON public.customer_zt(customer_id);

CREATE TABLE IF NOT EXISTS public.sales_tax_zt (
  id            SERIAL PRIMARY KEY,
  sales_tax_id  INTEGER NOT NULL REFERENCES sales_tax(id) ON DELETE CASCADE,
  company_id    INTEGER NOT NULL,
  zt_rate_id    VARCHAR(64) NOT NULL,
  raw           JSONB,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sales_tax_zt_company_rate UNIQUE (company_id, zt_rate_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_tax_zt_salestax ON public.sales_tax_zt(sales_tax_id);

ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS zt_ticket_id VARCHAR(64);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS zt_estimate_id VARCHAR(64);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS zt_billing_meta_data_id VARCHAR(64);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS zt_synced_at TIMESTAMP(3);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS zt_sync_error TEXT;

ALTER TABLE public.pricebooks ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'MANUAL';

ALTER TABLE public.zt_connections ADD COLUMN IF NOT EXISTS refresh_lock_until TIMESTAMP(3);
-- Heals a zt_connections created from the pre-amendment phase5: CREATE TABLE IF NOT EXISTS
-- never adds columns to an existing table, so the column ships here idempotently too.
ALTER TABLE public.zt_connections ADD COLUMN IF NOT EXISTS zt_company_name VARCHAR(200);

-- Copilot-server's OWN enum (not the platform's crm_* family — extending those is forbidden;
-- this one is ours). ADD VALUE cannot run inside a transaction block on older PG; run alone.
ALTER TYPE public.pricebook_source ADD VALUE IF NOT EXISTS 'ZENTRADES';


-- ============================================================================
-- 7. ownership, grants, verification
-- ============================================================================


-- ---------------------------------------------------------------- ownership + grants
-- phase4/5/6 tables are created by the master role here; without this the app cannot
-- write them (same pattern as customers/sales_tax above and the 2026-09-07 QBO block).
ALTER TABLE public.proposal_templates  OWNER TO app_user;
ALTER TABLE public.zt_connections      OWNER TO app_user;
ALTER TABLE public.zt_jobs_raw         OWNER TO app_user;
ALTER TABLE public.zt_deficiencies_raw OWNER TO app_user;
ALTER TABLE public.zt_catalog_raw      OWNER TO app_user;
ALTER TABLE public.customer_zt         OWNER TO app_user;
ALTER TABLE public.sales_tax_zt        OWNER TO app_user;
GRANT USAGE ON SEQUENCE public.proposal_templates_id_seq  TO app_user;
GRANT USAGE ON SEQUENCE public.zt_connections_id_seq      TO app_user;
GRANT USAGE ON SEQUENCE public.zt_jobs_raw_id_seq         TO app_user;
GRANT USAGE ON SEQUENCE public.zt_deficiencies_raw_id_seq TO app_user;
GRANT USAGE ON SEQUENCE public.zt_catalog_raw_id_seq      TO app_user;
GRANT USAGE ON SEQUENCE public.customer_zt_id_seq         TO app_user;
GRANT USAGE ON SEQUENCE public.sales_tax_zt_id_seq        TO app_user;

-- ---------------------------------------------------------------- final verification
-- Fails loudly rather than reporting a partial apply as success.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(x, ', ') INTO missing FROM (
    SELECT t FROM unnest(ARRAY[
      'customers','customer_qb','sales_tax','sales_tax_qb','proposal_templates',
      'zt_connections','zt_jobs_raw','zt_deficiencies_raw','zt_catalog_raw',
      'customer_zt','sales_tax_zt'
    ]) t WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t)
    UNION ALL
    SELECT 'quotes.' || c FROM unnest(ARRAY[
      'customer_id','sales_tax_id','tax_rate_percent','proposal_template_id','template_asked',
      'zt_ticket_id','zt_estimate_id','zt_billing_meta_data_id','zt_synced_at','zt_sync_error'
    ]) c WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'quotes' AND column_name = c)
    UNION ALL
    SELECT 'pricebooks.source' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pricebooks' AND column_name = 'source')
    UNION ALL
    SELECT 'enum:ZENTRADES' WHERE NOT EXISTS (
      SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'pricebook_source' AND e.enumlabel = 'ZENTRADES')
  ) s(x);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'CATCHUP INCOMPLETE — missing: %', missing;
  END IF;
  RAISE NOTICE 'PROD_CATCHUP_2026_09_10_APPLIED';
END $$;
