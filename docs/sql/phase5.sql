-- Phase 5 — "Enable tax": one company-level switch.
--
-- WHAT THIS IS FOR. Whether sales tax applies to a company's estimates at all was not a stored
-- fact. It was inferred from whether a default rate happened to be set, which conflates two
-- different things: a company that does not charge sales tax, and a company that does but has not
-- yet said which rate. The first is a decision, the second is an unfinished setup, and a screen
-- that cannot tell them apart cannot report either honestly.
--
-- DEFAULT FALSE, deliberately. Most companies do not charge sales tax, and a rate that starts
-- applying itself the moment someone configures one is a surprise measured in money. Every
-- existing company therefore reads "off" after this runs — which is a behaviour change ONLY for a
-- company that had a MANUAL default rate and no QuickBooks connection. For them, new estimates
-- start untaxed until an admin turns the switch on. Estimates that already exist are untouched:
-- the rate is a snapshot on the quote, and nothing here reads or writes quotes.
--
-- A company connected to QuickBooks is unaffected regardless of the stored value: taxEnabledFor()
-- forces it on, because the books hold the rates and the tax codes and an estimate declaring no
-- tax would disagree with what QuickBooks bills for the same document.
--
-- ORDER: THIS RUNS BEFORE THE IMAGE THAT USES IT. Not "safe to add after" — Prisma SELECTs every
-- scalar column its generated client knows about, so the moment the new image deploys it asks for
-- company_configs.tax_enabled on every settings read. Deploy the DDL first, then the image.
--
-- ROLLING BACK: drop the column. Nothing else references it, no data is derived from it, and the
-- previous image never selects it.
--     ALTER TABLE public.company_configs DROP COLUMN tax_enabled;

ALTER TABLE public.company_configs
  ADD COLUMN IF NOT EXISTS tax_enabled BOOLEAN NOT NULL DEFAULT false;

-- Verify AS app_user, not as the migration role: ownership and grants are the thing that differs,
-- and a column the migration role can see is not proof the service can.
