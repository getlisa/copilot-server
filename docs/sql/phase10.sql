-- Phase 10: HTML proposal documents (2026-09-17).
-- A proposal_templates row may name an HTML file in the repo instead of carrying blocks;
-- everything that selects a template (chat ask, job-type match, default) is unchanged.
-- Idempotent; runs via the runbook / docs/CLOUDSHELL_PROD_SQL.md — never prisma migrate.
-- ORDER: run BEFORE the image that reads this column deploys.
--
-- DEPLOY NOTE: the image that reads this column also installs `chromium` (plus Liberation and
-- DejaVu fonts) and sets CHROMIUM_PATH=/usr/bin/chromium — HTML proposals are printed to PDF
-- by a headless browser. That is roughly +0.5GB of image and a few hundred MB of RAM per
-- render, so check the ECS task's memory reservation first. Without Chromium the server still
-- runs: HTML templates fall back to the block renderer rather than failing a download.

ALTER TABLE public.proposal_templates ADD COLUMN IF NOT EXISTS html_file VARCHAR(120);
