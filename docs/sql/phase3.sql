-- ============================================================================
-- QBO Phase 3 — the customer name key was too strict
--
-- `customers` was unique on (company_id, name), on the premise that QuickBooks'
-- DisplayName is unique across the whole realm. A sandbox probe settled it on
-- 2026-09-08 and the premise was WRONG: Intuit accepted
--
--     Mark Cho:Building 1
--
-- while "Mahee Zentrades:Building 1" already existed. DisplayName is SIBLING-unique,
-- not realm-unique. So the old key refused customers QuickBooks would take — a
-- technician adding "Building 1" to a second property was told it already existed,
-- when it is a different building on a different site.
--
-- NULLS NOT DISTINCT is the load-bearing half. Every root customer has parent_id
-- NULL, and Postgres treats NULLs as distinct by default — so a plain
-- UNIQUE (company_id, parent_id, name) would allow two top-level "Acme"s and lose
-- the guarantee exactly where it matters most. Requires Postgres 15+; production is
-- 17.6. Prisma cannot express this, so schema.prisma declares the columns and a
-- comment records the divergence, the same way `sales_tax_one_default_per_company`
-- already does.
--
-- Verified before running: zero (company_id, parent_id, name) collisions in the
-- existing data, and zero names carrying the "(qboId)" suffix the old key forced.
--
-- Safe in either deploy order — it only ever ACCEPTS more rows than before — but it
-- is grouped with the code that stops sending the narrower key.
-- ============================================================================

DO $$ BEGIN
  ALTER TABLE "public"."customers"
    ADD CONSTRAINT "customers_company_id_parent_id_name_key"
    UNIQUE NULLS NOT DISTINCT ("company_id", "parent_id", "name");
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

-- Dropped only after the replacement exists, so there is no window in which a
-- duplicate name could be inserted.
ALTER TABLE "public"."customers" DROP CONSTRAINT IF EXISTS "customers_company_id_name_key";
DROP INDEX IF EXISTS "public"."customers_company_id_name_key";

-- ---------- verification ----------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='customers'
       AND indexname='customers_company_id_parent_id_name_key'
  ) THEN
    RAISE EXCEPTION 'PHASE3 — the new key was not created';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='customers'
       AND indexname='customers_company_id_name_key'
  ) THEN
    RAISE EXCEPTION 'PHASE3 — the old key is still present';
  END IF;

  -- The whole point: NULLS NOT DISTINCT must actually be on it, or two top-level
  -- customers could share a name and nothing would say so until a sync collided.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'customers_company_id_parent_id_name_key'
       AND i.indnullsnotdistinct
  ) THEN
    RAISE EXCEPTION 'PHASE3 — the new key is missing NULLS NOT DISTINCT';
  END IF;

  RAISE NOTICE 'PHASE3_APPLIED';
END $$;
