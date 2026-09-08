-- ============================================================================
-- QBO Phase 1b (expand) — tax on estimates, sub-customers, structured address
--
-- ORDER MATTERS: this block runs BEFORE the image that uses it ships.
-- Prisma SELECTs every scalar column it knows about, so the moment the new
-- client is deployed it asks for quote_line_items.taxable on every quote read.
-- Running the DDL afterwards means every estimate screen 500s in between.
-- (The runbook's "new nullable columns are safe to add after deploy" line is
-- wrong for Prisma and is corrected in the same PR as this file.)
--
-- Every statement is additive and IF NOT EXISTS, so a partial run is safe to
-- repeat. Nothing here drops or rewrites an existing column.
-- Names are copied verbatim from:
--   npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
-- ============================================================================

-- ---------- customers: sub-customer parent + structured address ----------
ALTER TABLE "public"."customers" ADD COLUMN IF NOT EXISTS "parent_id" INTEGER;
ALTER TABLE "public"."customers" ADD COLUMN IF NOT EXISTS "address_line1" TEXT;
ALTER TABLE "public"."customers" ADD COLUMN IF NOT EXISTS "address_line2" TEXT;
ALTER TABLE "public"."customers" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "public"."customers" ADD COLUMN IF NOT EXISTS "state" TEXT;
ALTER TABLE "public"."customers" ADD COLUMN IF NOT EXISTS "postal_code" TEXT;
ALTER TABLE "public"."customers" ADD COLUMN IF NOT EXISTS "country" TEXT;

DO $$ BEGIN
  ALTER TABLE "public"."customers"
    ADD CONSTRAINT "customers_parent_id_fkey"
    FOREIGN KEY ("parent_id") REFERENCES "public"."customers"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A row cannot be its own parent. The column is self-referential and no
-- re-parenting path exists yet, so this is a backstop against the day one does.
DO $$ BEGIN
  ALTER TABLE "public"."customers"
    ADD CONSTRAINT "customers_parent_not_self" CHECK ("parent_id" IS DISTINCT FROM "id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "customers_parent_id_idx" ON "public"."customers"("parent_id");

-- ---------- quotes: the sales-tax snapshot ----------
ALTER TABLE "public"."quotes" ADD COLUMN IF NOT EXISTS "sales_tax_id" INTEGER;
ALTER TABLE "public"."quotes" ADD COLUMN IF NOT EXISTS "tax_rate_percent" DECIMAL(6,4);
ALTER TABLE "public"."quotes" ADD COLUMN IF NOT EXISTS "tax_exempt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "public"."quotes" ADD COLUMN IF NOT EXISTS "qbo_synced_at" TIMESTAMP(3);
ALTER TABLE "public"."quotes" ADD COLUMN IF NOT EXISTS "qbo_sync_error" TEXT;

-- RESTRICT, not SET NULL: rates are only ever soft-deleted, so this never fires
-- in normal operation. If one were hard-deleted, SET NULL would clear the id and
-- leave the percentage behind — an estimate quoting a rate that belongs to
-- nothing, and a violation of the pairing CHECK below.
DO $$ BEGIN
  ALTER TABLE "public"."quotes"
    ADD CONSTRAINT "quotes_sales_tax_id_fkey"
    FOREIGN KEY ("sales_tax_id") REFERENCES "public"."sales_tax"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The two snapshot columns move together or not at all. Prisma cannot express
-- this, and a half-set pair is the shape that renders tax on the document while
-- the QuickBooks post finds no code to declare — or the reverse.
DO $$ BEGIN
  ALTER TABLE "public"."quotes"
    ADD CONSTRAINT "quotes_tax_snapshot_paired"
    CHECK (("sales_tax_id" IS NULL) = ("tax_rate_percent" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "quotes_sales_tax_id_idx" ON "public"."quotes"("sales_tax_id");

-- ---------- quote_line_items: per-line taxability ----------
-- Defaults true (materials are the common case); labor lines are seeded false at
-- creation, matching the "Taxed" column the estimate PDF has always printed.
ALTER TABLE "public"."quote_line_items" ADD COLUMN IF NOT EXISTS "taxable" BOOLEAN NOT NULL DEFAULT true;

-- ---------- qbo_connections: sync state and the realm's tax mode ----------
ALTER TABLE "public"."qbo_connections" ADD COLUMN IF NOT EXISTS "last_sync_at" TIMESTAMP(3);
ALTER TABLE "public"."qbo_connections" ADD COLUMN IF NOT EXISTS "last_sync_error" TEXT;
ALTER TABLE "public"."qbo_connections" ADD COLUMN IF NOT EXISTS "sync_started_at" TIMESTAMP(3);
ALTER TABLE "public"."qbo_connections" ADD COLUMN IF NOT EXISTS "using_sales_tax" BOOLEAN;
ALTER TABLE "public"."qbo_connections" ADD COLUMN IF NOT EXISTS "partner_tax_enabled" BOOLEAN;

-- ---------- verification ----------
-- Fails loudly rather than reporting a partial apply as a success.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(x, ', ') INTO missing FROM (
    SELECT 'customers.' || c FROM unnest(ARRAY[
      'parent_id','address_line1','address_line2','city','state','postal_code','country'
    ]) c WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='customers' AND column_name=c)
    UNION ALL
    SELECT 'quotes.' || c FROM unnest(ARRAY[
      'sales_tax_id','tax_rate_percent','tax_exempt','qbo_synced_at','qbo_sync_error'
    ]) c WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='quotes' AND column_name=c)
    UNION ALL
    SELECT 'quote_line_items.taxable' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='quote_line_items' AND column_name='taxable')
    UNION ALL
    SELECT 'qbo_connections.' || c FROM unnest(ARRAY[
      'last_sync_at','last_sync_error','sync_started_at','using_sales_tax','partner_tax_enabled'
    ]) c WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='qbo_connections' AND column_name=c)
  ) t(x);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'PHASE1B INCOMPLETE — missing: %', missing;
  END IF;
  RAISE NOTICE 'PHASE1B_APPLIED';
END $$;
