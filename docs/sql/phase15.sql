-- Phase 15: Housecall Pro integration (jobs + price book in, job line items + proposal PDF out) —
-- the phase14 shapes, split by provider on purpose (never extend the platform-owned crm_*).
-- No tax table: Housecall Pro has no tax-rate API; the job carries its own tax inside HCP.
-- Idempotent; runs via the runbook / docs/CLOUDSHELL_PROD_SQL.md — never prisma migrate.
-- ORDER: run BEFORE the image that reads these columns deploys (Prisma SELECTs every column).
-- Run as the Aurora MASTER user (app_user cannot DDL); ownership handed over at the end.

CREATE TABLE IF NOT EXISTS public.hcp_connections (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL UNIQUE,
  encrypted_auth    TEXT,
  hcp_company_id    TEXT,
  hcp_company_name  VARCHAR(200),
  last_sync_at      TIMESTAMP(3),
  last_sync_error   TEXT,
  sync_started_at   TIMESTAMP(3),
  created_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.hcp_jobs_raw (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL,
  hcp_job_id      VARCHAR(64) NOT NULL,
  invoice_number  VARCHAR(64),
  work_status     VARCHAR(32),
  hcp_updated_at  TIMESTAMP(3),
  raw_payload     JSONB NOT NULL,
  content_hash    VARCHAR(64) NOT NULL,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hcp_jobs_raw_company_job UNIQUE (company_id, hcp_job_id)
);
CREATE INDEX IF NOT EXISTS idx_hcp_jobs_raw_company_updated
  ON public.hcp_jobs_raw(company_id, hcp_updated_at DESC);

CREATE TABLE IF NOT EXISTS public.customer_hcp (
  id               SERIAL PRIMARY KEY,
  customer_id      INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  company_id       INTEGER NOT NULL,
  hcp_customer_id  VARCHAR(64) NOT NULL,
  raw              JSONB,
  created_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT customer_hcp_company_customer UNIQUE (company_id, hcp_customer_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_hcp_customer ON public.customer_hcp(customer_id);

ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS hcp_job_id      VARCHAR(64);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS hcp_synced_at   TIMESTAMP(3);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS hcp_sync_error  TEXT;

ALTER TYPE public.pricebook_source ADD VALUE IF NOT EXISTS 'HOUSECALL_PRO';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    ALTER TABLE public.hcp_connections  OWNER TO app_user;
    ALTER TABLE public.hcp_jobs_raw     OWNER TO app_user;
    ALTER TABLE public.customer_hcp     OWNER TO app_user;
    GRANT USAGE ON SEQUENCE public.hcp_connections_id_seq TO app_user;
    GRANT USAGE ON SEQUENCE public.hcp_jobs_raw_id_seq    TO app_user;
    GRANT USAGE ON SEQUENCE public.customer_hcp_id_seq    TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quotes TO app_user;
  END IF;
END $$;
