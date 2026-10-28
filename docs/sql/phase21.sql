-- Phase 21: Housecall Pro customers, synced like jobs (2026-10-28). A technician can start an
-- estimate from an HCP CUSTOMER with no job yet; the picker reads this table, the HCP sync fills
-- it (GET /customers, raw-first with a content hash, the hcp_jobs_raw shape). The estimate still
-- posts through customer_hcp → quotes.customer_id; no new quotes column.
-- Additive and idempotent; runs via docs/sql/apply-phase21.sh — never prisma migrate.
-- ORDER: run BEFORE the image that writes it deploys (the sync stage INSERTs here).

CREATE TABLE IF NOT EXISTS public.hcp_customers_raw (
  id               SERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  hcp_customer_id  VARCHAR(64) NOT NULL,
  name             VARCHAR(255),
  hcp_updated_at   TIMESTAMP(3),
  raw_payload      JSONB NOT NULL,
  content_hash     VARCHAR(64) NOT NULL,
  created_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hcp_customers_raw_company_customer UNIQUE (company_id, hcp_customer_id)
);
CREATE INDEX IF NOT EXISTS idx_hcp_customers_raw_company_updated
  ON public.hcp_customers_raw(company_id, hcp_updated_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    ALTER TABLE public.hcp_customers_raw OWNER TO app_user;
    GRANT USAGE ON SEQUENCE public.hcp_customers_raw_id_seq TO app_user;
  END IF;
END $$;
