-- Phase 5b — preserve existing behaviour for the Enable-tax switch.
--
-- WHY THIS EXISTS. phase5.sql added company_configs.tax_enabled with DEFAULT false, which is the
-- right default for a NEW company: most do not charge sales tax, and a rate that starts applying
-- itself the moment someone configures one is a surprise measured in money.
--
-- It is the wrong value for a company that is ALREADY charging tax. Before this column, "does
-- this company tax its estimates" was inferred from whether an active default rate was set. So
-- every company holding one was taxing, and after phase5.sql they all read "off" — their next
-- estimate would be built untaxed, silently, on customer-facing money.
--
-- Worse, they could not fix it themselves for a while: the switch that turns tax back on ships
-- from technician-copilot, which deploys separately from copilot-server. Backend-first would have
-- left a window with the behaviour changed and no control anywhere to change it back.
--
-- So: any company that already had an active default rate keeps taxing. Everyone else — and every
-- company created from now on — starts off, which is the decision phase5.sql documents.
--
-- Companies connected to QuickBooks or a CRM are not the target of this. taxEnabledFor() forces
-- them on from the connection regardless of what is stored here, so they are unaffected either
-- way. They are still caught by the condition below when they hold a default rate, which simply
-- makes the stored row agree with the effective behaviour instead of contradicting it.
--
-- ORDER: after phase5.sql, before the image deploys. Idempotent — re-running changes nothing,
-- because it only ever moves false -> true for rows that still satisfy the condition.
--
-- ROLLING BACK: there is no meaningful rollback, and none is needed. If tax_enabled itself is
-- dropped (the phase5.sql rollback), this goes with it.

-- 1. Companies with a config row: switch tax on where a default rate is already in force.
UPDATE public.company_configs cc
   SET tax_enabled = true
 WHERE cc.tax_enabled = false
   AND EXISTS (
         SELECT 1
           FROM public.sales_tax st
          WHERE st.company_id = cc.company_id
            AND st.is_default = true
            AND st.is_active  = true
            AND st.is_deleted = false
       );

-- 2. Companies with a default rate but NO config row at all.
--    company_configs is created lazily — the markup endpoint upserts it — so a company can be
--    taxing today with no row here. taxEnabledFor() reads a missing row as false, so without this
--    they are exactly the companies phase5.sql would silently untax, and statement 1 cannot reach
--    them. `checklists` is NOT NULL with no default and is constrained to an array, so it is
--    seeded empty, the same value the markup endpoint's create uses.
INSERT INTO public.company_configs (company_id, checklists, tax_enabled)
SELECT DISTINCT st.company_id, '[]'::jsonb, true
  FROM public.sales_tax st
 WHERE st.is_default = true
   AND st.is_active  = true
   AND st.is_deleted = false
   AND NOT EXISTS (
         SELECT 1 FROM public.company_configs cc WHERE cc.company_id = st.company_id
       )
ON CONFLICT (company_id) DO NOTHING;
