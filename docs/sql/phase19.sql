-- Phase 19: the facts the Estimating Agent metrics need and the schema does not keep
-- (product metrics spec, 2026-10-14). Six metrics are uncomputable today because the database
-- stores only final state: it knows a line was edited, not whether the price or the quantity
-- moved, and it records neither where a quote came from nor whether it ever reached a
-- customer. Removed lines are phase20's concern. Additive and idempotent; runs via
-- docs/sql/apply-phase19.sh — never prisma migrate.
-- ORDER: run BEFORE the image that writes these columns deploys.

-- Edit provenance. `manually_edited` is one boolean, so "Price override rate" and "Quantity
-- edit rate" would report the identical number. The original values also let a reviewer see
-- how far a technician moved the agent's figure, not merely that they did.
ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS price_edited_at     TIMESTAMP(6);
ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS quantity_edited_at  TIMESTAMP(6);
ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS original_unit_price NUMERIC(12, 2);
ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS original_quantity   NUMERIC(12, 2);

-- Quote origin. Nothing distinguishes a CRM-started quote from a plain new chat: quote
-- conversations carry no job_id and crm_entity_links is empty, so the split cannot be derived
-- from existing joins. A CHECK rather than an enum type — cheaper to extend, and an enum would
-- have to be created before any column could reference it.
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS origin          VARCHAR(16);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS origin_provider VARCHAR(32);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS origin_job_ref  VARCHAR(128);

-- Share tracking. The email and document endpoints exist but leave no trace, so "Share rate"
-- has nothing to count. First-send only: emailing one quote twice is one shared quote, and
-- counting events instead would push the rate above 100%.
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS first_shared_at TIMESTAMP(6);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS share_channel   VARCHAR(16);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS share_count     INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotes_origin_check') THEN
    ALTER TABLE public.quotes ADD CONSTRAINT quotes_origin_check
      CHECK (origin IS NULL OR origin IN ('crm', 'manual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotes_share_channel_check') THEN
    ALTER TABLE public.quotes ADD CONSTRAINT quotes_share_channel_check
      CHECK (share_channel IS NULL OR share_channel IN ('email', 'docx', 'pdf'));
  END IF;
END $$;

-- Completed-quote metrics bucket on completed_at and filter on status, and every one of them
-- scans the same slice.
CREATE INDEX IF NOT EXISTS quotes_completed_at_idx
  ON public.quotes (completed_at) WHERE status = 'COMPLETED';

COMMENT ON COLUMN public.quote_line_items.price_edited_at IS
  'Set the first time a technician changes unit_price. Null means the agent''s price stands.';
COMMENT ON COLUMN public.quote_line_items.quantity_edited_at IS
  'Set the first time a technician changes quantity. Null means the agent''s quantity stands.';
COMMENT ON COLUMN public.quote_line_items.original_unit_price IS
  'unit_price as the agent first proposed it. Captured once, on the first price edit.';
COMMENT ON COLUMN public.quote_line_items.original_quantity IS
  'quantity as the agent first proposed it. Captured once, on the first quantity edit.';
COMMENT ON COLUMN public.quotes.origin IS
  'crm = started from a CRM job picker, manual = started from a plain new chat. Null on rows
   that predate this column: unknown, which the metric must not read as manual.';
COMMENT ON COLUMN public.quotes.first_shared_at IS
  'Set once, on the first successful send or download. Never overwritten.';
