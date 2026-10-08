-- Phase 16: Home Depot fallback pricing OFF by default for NEW accounts only (product, 2026-10-08).
-- Existing accounts keep exactly what they have today: every company that has a config row keeps
-- its value; every company WITHOUT a row has been running with the fallback ON (code default), so
-- it gets a row that says so BEFORE the default flips. Only companies created after this
-- migration start with the fallback off.
-- Idempotent; runs via the runbook / docs/CLOUDSHELL_PROD_SQL.md — never prisma migrate.
-- ORDER: run BEFORE the image whose code default is OFF deploys — an existing company with no
-- config row would otherwise read as OFF the moment that image starts.

-- 1. Freeze today's effective value (ON) for every existing company that has no config row.
INSERT INTO public.company_configs (company_id, checklists, hd_fallback_enabled)
SELECT c.id, '[]'::jsonb, true
FROM public.companies c
WHERE NOT EXISTS (SELECT 1 FROM public.company_configs cc WHERE cc.company_id = c.id);

-- 2. New rows default to OFF from here on.
ALTER TABLE public.company_configs ALTER COLUMN hd_fallback_enabled SET DEFAULT false;
