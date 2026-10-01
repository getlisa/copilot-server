-- Phase 13: Uptick integration (jobs in, defect quote + proposal PDF out) — the ZenTrades
-- phase7/phase8 shapes, split by provider on purpose (never extend the platform-owned crm_*).
-- Idempotent; runs via the runbook / docs/CLOUDSHELL_PROD_SQL.md — never prisma migrate.
-- ORDER: run BEFORE the image that reads these columns deploys (Prisma SELECTs every column).
-- Run as the Aurora MASTER user (app_user cannot DDL); ownership handed over at the end like
-- prod-catchup-2026-09-10.sql did for the zt_* tables.

CREATE TABLE IF NOT EXISTS public.uptick_connections (
  id                       SERIAL PRIMARY KEY,
  -- No FK to companies (the qbo_connections precedent): companies.id differs across the
  -- Supabase projects, and a stale row costs nothing.
  company_id               INTEGER NOT NULL UNIQUE,
  base_url                 VARCHAR(200) NOT NULL,
  encrypted_auth           TEXT,
  access_token_expires_at  TIMESTAMP(3),
  last_sync_at             TIMESTAMP(3),
  last_sync_error          TEXT,
  sync_started_at          TIMESTAMP(3),
  refresh_lock_until       TIMESTAMP(3),
  created_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.uptick_tasks_raw (
  id                 SERIAL PRIMARY KEY,
  company_id         INTEGER NOT NULL,
  uptick_task_id     VARCHAR(64) NOT NULL,
  ref                VARCHAR(64),
  status             VARCHAR(64),
  uptick_updated_at  TIMESTAMP(3),
  raw_payload        JSONB NOT NULL,
  content_hash       VARCHAR(64) NOT NULL,
  created_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uptick_tasks_raw_company_task UNIQUE (company_id, uptick_task_id)
);
CREATE INDEX IF NOT EXISTS idx_uptick_tasks_raw_company_updated
  ON public.uptick_tasks_raw(company_id, uptick_updated_at DESC);

CREATE TABLE IF NOT EXISTS public.uptick_remarks_raw (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL,
  uptick_remark_id    VARCHAR(64) NOT NULL,
  uptick_task_id      VARCHAR(64),
  uptick_property_id  VARCHAR(64),
  status              VARCHAR(64),
  raw_payload         JSONB NOT NULL,
  content_hash        VARCHAR(64) NOT NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uptick_remarks_raw_company_remark UNIQUE (company_id, uptick_remark_id)
);
CREATE INDEX IF NOT EXISTS idx_uptick_remarks_raw_task
  ON public.uptick_remarks_raw(company_id, uptick_task_id);
CREATE INDEX IF NOT EXISTS idx_uptick_remarks_raw_property
  ON public.uptick_remarks_raw(company_id, uptick_property_id);

CREATE TABLE IF NOT EXISTS public.customer_uptick (
  id                SERIAL PRIMARY KEY,
  customer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  company_id        INTEGER NOT NULL,
  uptick_client_id  VARCHAR(64) NOT NULL,
  raw               JSONB,
  created_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT customer_uptick_company_client UNIQUE (company_id, uptick_client_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_uptick_customer ON public.customer_uptick(customer_id);

ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS uptick_task_id     VARCHAR(64);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS uptick_quote_id    VARCHAR(64);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS uptick_quote_ref   VARCHAR(64);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS uptick_synced_at   TIMESTAMP(3);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS uptick_sync_error  TEXT;

-- Uptick products project into a CLARA pricebook (the ZenTrades catalog pattern), so every
-- defect-quote line can carry the product Uptick requires. Enum value only; no data.
ALTER TYPE public.pricebook_source ADD VALUE IF NOT EXISTS 'UPTICK';

-- Prod only: app_user is the Aurora service role. Dev Supabase has no such role; skip there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    ALTER TABLE public.uptick_connections OWNER TO app_user;
    ALTER TABLE public.uptick_tasks_raw   OWNER TO app_user;
    ALTER TABLE public.uptick_remarks_raw OWNER TO app_user;
    ALTER TABLE public.customer_uptick    OWNER TO app_user;
    GRANT USAGE ON SEQUENCE public.uptick_connections_id_seq TO app_user;
    GRANT USAGE ON SEQUENCE public.uptick_tasks_raw_id_seq   TO app_user;
    GRANT USAGE ON SEQUENCE public.uptick_remarks_raw_id_seq TO app_user;
    GRANT USAGE ON SEQUENCE public.customer_uptick_id_seq    TO app_user;
    -- quotes is owned by postgres; a column added after the table grant inherits it (phase9 note).
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quotes TO app_user;
  END IF;
END $$;
