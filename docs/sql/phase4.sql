-- Phase 4: proposal template library (ZenTrades plan, Feature B / Phase 1).
-- The single companies.proposal_template Json column becomes a per-company library of named
-- templates. Existing designs migrate as one row named 'Default'; the column is kept as a
-- read-fallback for one release, then dropped in a later phase.
--
-- Idempotent: safe to re-run. Runs via the runbook (docs/PROD_DB_MIGRATION_RUNBOOK.md) —
-- never prisma migrate/db push. DDL runs BEFORE the image that reads these columns.

CREATE TABLE IF NOT EXISTS public.proposal_templates (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        VARCHAR(120) NOT NULL,
  blocks      JSONB NOT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_proposal_templates_company
  ON public.proposal_templates(company_id);

-- Exactly one default per company. Partial unique index: Prisma cannot express this, the
-- schema.prisma model comment records the divergence (same pattern as
-- sales_tax_one_default_per_company).
CREATE UNIQUE INDEX IF NOT EXISTS proposal_templates_one_default_per_company
  ON public.proposal_templates(company_id) WHERE is_default;

-- Migrate each company's existing single design to a 'Default' row. NOT EXISTS keeps a
-- re-run from duplicating; nobody's proposals change on launch day.
INSERT INTO public.proposal_templates (company_id, name, blocks, is_default)
SELECT c.id, 'Default', c.proposal_template, TRUE
FROM public.companies c
WHERE c.proposal_template IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.proposal_templates pt WHERE pt.company_id = c.id);

-- The chat's template choice + once-per-quote ask latch (mirrors labor_asked).
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS proposal_template_id INTEGER;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS template_asked BOOLEAN NOT NULL DEFAULT FALSE;
