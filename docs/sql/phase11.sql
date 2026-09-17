-- Phase 11: uploaded HTML proposal documents (2026-09-17).
-- A proposal_templates row may STORE its HTML document (uploaded or edited in the admin UI)
-- instead of naming a file in the repo. Render precedence: html_file → html → blocks.
-- Idempotent; runs via the runbook / docs/CLOUDSHELL_PROD_SQL.md — never prisma migrate.
-- ORDER: run BEFORE the image that reads this column deploys.

ALTER TABLE public.proposal_templates ADD COLUMN IF NOT EXISTS html TEXT;
