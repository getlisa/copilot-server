-- Phase 18: Organization price memory (price-memory PRD, Siva 2026-10-08; built 2026-10-12).
-- Technicians with the learning permission teach prices for products outside the pricebook;
-- every technician in the company then gets that price auto-filled. Three additive changes:
--   1. users.price_memory_learner — the per-technician permission, off by default (FR-1..3)
--   2. price_memory — the per-company memory store (FR-6/7/9/17/18)
--   3. quote_line_items.price_memory_id — which entry priced a line (FR-12/13)
-- Idempotent; runs via docs/sql/apply-phase18.sh — never prisma migrate.
-- ORDER: run BEFORE the image that reads these columns deploys (Prisma SELECTs every column).
-- Run as the Aurora MASTER user (app_user cannot DDL); ownership handed over at the end.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS price_memory_learner BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.price_memory (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL,
  name            TEXT NOT NULL,
  name_key        TEXT NOT NULL,
  description     TEXT,
  rate            DECIMAL(12,2) NOT NULL,
  is_labor        BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  set_by_user_id  BIGINT NOT NULL,
  set_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_price_memory_company_key_active
  ON public.price_memory(company_id, name_key, is_active);

ALTER TABLE public.quote_line_items
  ADD COLUMN IF NOT EXISTS price_memory_id INTEGER;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    ALTER TABLE public.price_memory OWNER TO app_user;
    GRANT USAGE ON SEQUENCE public.price_memory_id_seq TO app_user;
  END IF;
END $$;
