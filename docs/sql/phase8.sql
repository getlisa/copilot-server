-- Phase 8: ZenTrades sync + write-back schema (plan items 3, 5-8).
-- (Was "phase6" on the feature branch; renumbered — see phase7.sql. Content unchanged;
-- prod got it via prod-catchup-2026-09-10.sql.)
-- Raw-ingest tables (collections-agent pattern), link tables (QBO _qb pattern), quote linkage
-- columns, pricebook source marker, and the re-login serialization lock.
-- Idempotent; runs via the runbook or docs/CLOUDSHELL_PROD_SQL.md — never prisma migrate.
-- ORDER: run BEFORE the image that reads it deploys (with or after phase7).

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
-- Heals a zt_connections created from the pre-amendment ZT-connection migration: CREATE TABLE IF NOT EXISTS
-- never adds columns to an existing table, so the column ships here idempotently too.
ALTER TABLE public.zt_connections ADD COLUMN IF NOT EXISTS zt_company_name VARCHAR(200);

-- Copilot-server's OWN enum (not the platform's crm_* family — extending those is forbidden;
-- this one is ours). ADD VALUE cannot run inside a transaction block on older PG; run alone.
ALTER TYPE public.pricebook_source ADD VALUE IF NOT EXISTS 'ZENTRADES';
