-- Phase 14: ServiceTrade integration (jobs in, quote + proposal PDF out) — the phase13 (Uptick)
-- shapes, split by provider on purpose (never extend the platform-owned crm_*).
-- Idempotent; runs via the runbook / docs/CLOUDSHELL_PROD_SQL.md — never prisma migrate.
-- ORDER: run BEFORE the image that reads these columns deploys (Prisma SELECTs every column).
-- Run as the Aurora MASTER user (app_user cannot DDL); ownership handed over at the end.

CREATE TABLE IF NOT EXISTS public.servicetrade_connections (
  id                       SERIAL PRIMARY KEY,
  company_id               INTEGER NOT NULL UNIQUE,
  encrypted_auth           TEXT,
  st_company_id            TEXT,
  st_company_name          VARCHAR(200),
  st_user_id               TEXT,
  access_token_expires_at  TIMESTAMP(3),
  last_sync_at             TIMESTAMP(3),
  last_sync_error          TEXT,
  sync_started_at          TIMESTAMP(3),
  refresh_lock_until       TIMESTAMP(3),
  created_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.servicetrade_jobs_raw (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL,
  st_job_id      VARCHAR(64) NOT NULL,
  number         VARCHAR(64),
  status         VARCHAR(64),
  st_updated_at  TIMESTAMP(3),
  raw_payload    JSONB NOT NULL,
  content_hash   VARCHAR(64) NOT NULL,
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT servicetrade_jobs_raw_company_job UNIQUE (company_id, st_job_id)
);
CREATE INDEX IF NOT EXISTS idx_servicetrade_jobs_raw_company_updated
  ON public.servicetrade_jobs_raw(company_id, st_updated_at DESC);

CREATE TABLE IF NOT EXISTS public.servicetrade_deficiencies_raw (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL,
  st_deficiency_id  VARCHAR(64) NOT NULL,
  st_job_id         VARCHAR(64),
  st_location_id    VARCHAR(64),
  status            VARCHAR(32),
  resolution        VARCHAR(32),
  raw_payload       JSONB NOT NULL,
  content_hash      VARCHAR(64) NOT NULL,
  created_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT servicetrade_deficiencies_raw_company_def UNIQUE (company_id, st_deficiency_id)
);
CREATE INDEX IF NOT EXISTS idx_servicetrade_deficiencies_raw_job
  ON public.servicetrade_deficiencies_raw(company_id, st_job_id);
CREATE INDEX IF NOT EXISTS idx_servicetrade_deficiencies_raw_location
  ON public.servicetrade_deficiencies_raw(company_id, st_location_id);

CREATE TABLE IF NOT EXISTS public.customer_servicetrade (
  id              SERIAL PRIMARY KEY,
  customer_id     INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  company_id      INTEGER NOT NULL,
  st_customer_id  VARCHAR(64) NOT NULL,
  raw             JSONB,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT customer_servicetrade_company_customer UNIQUE (company_id, st_customer_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_servicetrade_customer ON public.customer_servicetrade(customer_id);

CREATE TABLE IF NOT EXISTS public.sales_tax_servicetrade (
  id               SERIAL PRIMARY KEY,
  sales_tax_id     INTEGER NOT NULL REFERENCES sales_tax(id) ON DELETE CASCADE,
  company_id       INTEGER NOT NULL,
  st_tax_group_id  VARCHAR(64) NOT NULL,
  raw              JSONB,
  created_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sales_tax_servicetrade_company_group UNIQUE (company_id, st_tax_group_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_tax_servicetrade_sales_tax ON public.sales_tax_servicetrade(sales_tax_id);

ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS st_job_id      VARCHAR(64);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS st_quote_id    VARCHAR(64);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS st_quote_ref   VARCHAR(64);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS st_synced_at   TIMESTAMP(3);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS st_sync_error  TEXT;

ALTER TYPE public.pricebook_source ADD VALUE IF NOT EXISTS 'SERVICETRADE';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    ALTER TABLE public.servicetrade_connections       OWNER TO app_user;
    ALTER TABLE public.servicetrade_jobs_raw          OWNER TO app_user;
    ALTER TABLE public.servicetrade_deficiencies_raw  OWNER TO app_user;
    ALTER TABLE public.customer_servicetrade          OWNER TO app_user;
    ALTER TABLE public.sales_tax_servicetrade         OWNER TO app_user;
    GRANT USAGE ON SEQUENCE public.servicetrade_connections_id_seq      TO app_user;
    GRANT USAGE ON SEQUENCE public.servicetrade_jobs_raw_id_seq         TO app_user;
    GRANT USAGE ON SEQUENCE public.servicetrade_deficiencies_raw_id_seq TO app_user;
    GRANT USAGE ON SEQUENCE public.customer_servicetrade_id_seq         TO app_user;
    GRANT USAGE ON SEQUENCE public.sales_tax_servicetrade_id_seq        TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quotes TO app_user;
  END IF;
END $$;
