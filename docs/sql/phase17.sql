-- Phase 17: Housecall Pro — a completed estimate posts as an HCP ESTIMATE (Estimates tab), no
-- longer onto the job's own line items (product, 2026-10-09). Three additive `quotes` columns:
-- the HCP estimate id, its single option id (lines live on the option), and HCP's human-facing
-- estimate_number. Idempotent; runs via docs/sql/apply-phase17.sh — never prisma migrate.
-- ORDER: run BEFORE the image that writes these columns deploys.

ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS hcp_estimate_id  VARCHAR(64);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS hcp_option_id    VARCHAR(64);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS hcp_estimate_ref VARCHAR(64);
