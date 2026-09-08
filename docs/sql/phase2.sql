-- ============================================================================
-- QBO Phase 2 (contract) — THE POINT OF NO RETURN
--
-- Dropping `quotes.qbo_customer_id` / `qbo_customer_name` makes the PREVIOUS image
-- unrollbackable: its Prisma client SELECTs those columns, so every quote read fails
-- the moment it starts. To roll back after this has run, re-add them FIRST:
--
--   ALTER TABLE public.quotes ADD COLUMN qbo_customer_id TEXT;
--   ALTER TABLE public.quotes ADD COLUMN qbo_customer_name TEXT;
--
-- ...and only then scale the old task definition up. They are nullable and nothing
-- reads them on the new image, so re-adding is cheap; forgetting is an outage.
--
-- Preconditions, all verified before this was run (2026-09-08):
--   - New image :101 live and EXERCISED — not just a 200 from /health. One estimate
--     posted to the sandbox with tax and a sub-customer, read back from Intuit with
--     TxnTaxCodeRef 3, TotalAmt 359.10 matching CLARA to the cent, and the customer
--     confirmed as a Job under its parent.
--   - T-39 passed twice on that image.
--   - `select count(*) from quotes where qbo_customer_id is not null` returned 0, so
--     nothing loses a QuickBooks link. There is no backfill by design; an older
--     estimate reaches QuickBooks through the per-estimate Sync button instead.
--   - No reference to any dropped object remains in schema.prisma or src/.
-- ============================================================================

-- ---------- the legacy per-quote customer id ----------
-- Superseded by quotes.customer_id -> customers -> customer_qb, which is realm-scoped:
-- a company that reconnects to a different QuickBooks file cannot end up with a stale
-- id attached to an estimate, which this flat column could not prevent.
ALTER TABLE public.quotes DROP COLUMN IF EXISTS qbo_customer_id;
ALTER TABLE public.quotes DROP COLUMN IF EXISTS qbo_customer_name;

-- ---------- the superseded raw mirrors ----------
-- Reference data only, re-syncable in about four seconds, and now duplicated by
-- customers / customer_qb / sales_tax / sales_tax_qb. Leaving them would leave two
-- tables claiming the same customers with no rule about which one wins.
--
-- raw_item_qb and raw_account_qb are deliberately NOT dropped: the item registry and
-- the income-account picker still read them, and schema.prisma still declares both.
DROP TABLE IF EXISTS public.raw_customer_qb;
DROP TABLE IF EXISTS public.raw_taxcode_qb;
DROP TABLE IF EXISTS public.raw_taxrate_qb;

-- ---------- verification ----------
DO $$
DECLARE remaining text;
BEGIN
  SELECT string_agg(x, ', ') INTO remaining FROM (
    SELECT 'quotes.' || column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='quotes'
       AND column_name IN ('qbo_customer_id','qbo_customer_name')
    UNION ALL
    SELECT table_name FROM information_schema.tables
     WHERE table_schema='public'
       AND table_name IN ('raw_customer_qb','raw_taxcode_qb','raw_taxrate_qb')
  ) t(x);
  IF remaining IS NOT NULL THEN
    RAISE EXCEPTION 'PHASE2 INCOMPLETE — still present: %', remaining;
  END IF;

  -- The mirrors that must SURVIVE. A DROP typo here would be silent otherwise, and the
  -- item registry losing its table is how every estimate starts creating duplicates.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='raw_item_qb')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_schema='public' AND table_name='raw_account_qb') THEN
    RAISE EXCEPTION 'PHASE2 DROPPED A TABLE IT SHOULD HAVE KEPT (raw_item_qb / raw_account_qb)';
  END IF;

  RAISE NOTICE 'PHASE2_APPLIED';
END $$;
