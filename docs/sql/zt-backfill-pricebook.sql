-- Backfill pricebook_items from zt_catalog_raw for ONE company, with no code deploy and no
-- ZenTrades API call. Same mapping as mapCatalogRow() in src/lib/ztIngest.ts: sellPrice is the
-- price field (the original code looked for `price` and so projected nothing), and each text
-- field falls through to the next NON-BLANK candidate because ZenTrades sends " " for unset.
--
-- Idempotent: re-running updates the rows it already wrote. Wrapped in a transaction — any
-- error rolls the whole thing back.
--
--   psql "$PROD_URL" -v cid=11 -f docs/sql/zt-backfill-pricebook.sql
--
-- Or set the company inline by editing the \set below and running \i.

\set ON_ERROR_STOP on
-- \set cid 11

BEGIN;

-- ---------------------------------------------------------------- map raw -> item fields
CREATE TEMP TABLE zt_map ON COMMIT DROP AS
SELECT
  r.id            AS raw_id,
  r.company_id,
  r.zt_item_id,
  COALESCE(
    NULLIF(btrim(r.raw_payload ->> 'code'), ''),
    NULLIF(btrim(r.raw_payload ->> 'identifier'), ''),
    NULLIF(btrim(r.raw_payload ->> 'sku'), ''),
    NULLIF(btrim(r.raw_payload ->> 'itemCode'), ''),
    'ZT-' || r.zt_item_id
  ) AS code,
  COALESCE(
    NULLIF(btrim(r.raw_payload ->> 'description'), ''),
    NULLIF(btrim(r.raw_payload ->> 'salesDescription'), ''),
    NULLIF(btrim(r.raw_payload ->> 'name'), ''),
    NULLIF(btrim(r.raw_payload ->> 'itemName'), ''),
    NULLIF(btrim(r.raw_payload ->> 'title'), ''),
    NULLIF(btrim(r.raw_payload ->> 'purchaseDescription'), ''),
    NULLIF(btrim(r.raw_payload ->> 'fullyQualifiedName'), ''),
    NULLIF(btrim(r.raw_payload ->> 'code'), ''),
    NULLIF(btrim(r.raw_payload ->> 'identifier'), '')
  ) AS description,
  NULLIF(btrim(COALESCE(
    r.raw_payload ->> 'sellPrice',
    r.raw_payload ->> 'price',
    r.raw_payload ->> 'unitPrice',
    r.raw_payload ->> 'rate',
    r.raw_payload ->> 'sellingPrice'
  )), '') AS price_text,
  COALESCE(
    NULLIF(btrim(r.raw_payload ->> 'unit'), ''),
    NULLIF(btrim(r.raw_payload ->> 'uom'), ''),
    'EA'
  ) AS unit
FROM public.zt_catalog_raw r
WHERE r.company_id = :cid
  -- deleted or deactivated in ZenTrades: not part of the catalog any more
  AND COALESCE(r.raw_payload ->> 'isDeleted', 'false') <> 'true'
  AND COALESCE(r.raw_payload ->> 'isActive', 'true') <> 'false';

-- Unpriced or unnamed rows stay in the raw store, unprojected. costPrice is NOT a fallback:
-- quoting cost as the price would sell the job at zero margin.
DELETE FROM zt_map
 WHERE description IS NULL
    OR price_text IS NULL
    OR price_text !~ '^-?[0-9]+(\.[0-9]+)?$';

-- One item per code, since pricebook_items is unique on company+code. Newest raw row wins.
DELETE FROM zt_map a USING zt_map b WHERE a.code = b.code AND a.raw_id < b.raw_id;

-- A company-authored code is never overwritten by the synced catalog: the ZenTrades book is
-- the lowest-priority book, so the admin's price would win the lookup anyway.
DELETE FROM zt_map m
 USING public.pricebook_items p
 WHERE p.company_id = m.company_id AND p.code = m.code AND p.source <> 'ZENTRADES';

\echo '--- rows that will be priced ---'
SELECT count(*) AS will_project FROM zt_map;

-- ---------------------------------------------------------------- target book
-- Priority 9999 = priced LAST, so any admin-uploaded book outranks it.
INSERT INTO public.pricebooks (company_id, name, priority, source, created_at, updated_at)
SELECT :cid, 'ZenTrades catalog', 9999, 'ZENTRADES', now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.pricebooks WHERE company_id = :cid AND name = 'ZenTrades catalog'
);

-- ---------------------------------------------------------------- project
UPDATE public.pricebook_items p
   SET description  = m.description,
       unit         = m.unit,
       unit_price   = m.price_text::numeric,
       pricebook_id = b.id,
       external_id  = m.zt_item_id
  FROM zt_map m, public.pricebooks b
 WHERE p.company_id = m.company_id
   AND p.code       = m.code
   AND b.company_id = :cid
   AND b.name       = 'ZenTrades catalog';

INSERT INTO public.pricebook_items
  (company_id, code, description, unit, unit_price, pricebook_id, source, external_id)
SELECT m.company_id, m.code, m.description, m.unit, m.price_text::numeric, b.id,
       'ZENTRADES', m.zt_item_id
  FROM zt_map m, public.pricebooks b
 WHERE b.company_id = :cid
   AND b.name       = 'ZenTrades catalog'
   AND NOT EXISTS (
     SELECT 1 FROM public.pricebook_items p
      WHERE p.company_id = m.company_id AND p.code = m.code
   );

-- Link each raw row to the item it produced, so a later sync updates instead of duplicating.
UPDATE public.zt_catalog_raw r
   SET projected_item_id = p.id,
       updated_at        = now()
  FROM zt_map m
  JOIN public.pricebook_items p
    ON p.company_id = m.company_id AND p.code = m.code
 WHERE r.id = m.raw_id;

-- ---------------------------------------------------------------- result
\echo '--- result ---'
SELECT
  (SELECT count(*) FROM public.pricebook_items
    WHERE company_id = :cid AND source = 'ZENTRADES')          AS zentrades_items,
  (SELECT count(*) FROM public.zt_catalog_raw
    WHERE company_id = :cid)                                   AS raw_rows,
  (SELECT count(*) FROM public.zt_catalog_raw
    WHERE company_id = :cid AND projected_item_id IS NULL)      AS still_unprojected;

COMMIT;
