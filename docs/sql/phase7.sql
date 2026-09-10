-- Phase 7: ZenTrades connection (ZenTrades plan 2.1/2.2 — connection only; sync comes later).
-- (Was "phase5" on the feature branch; renumbered — main claimed phase5/5b for the tax-enable
-- switch and phase6 for the QBO webhook ledger. Content unchanged; prod got it via
-- prod-catchup-2026-09-10.sql.)
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
