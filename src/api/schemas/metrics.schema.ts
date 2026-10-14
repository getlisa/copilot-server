import { z } from "zod";

/**
 * GET /api/v1/metrics-smolorbig
 *
 * `companyIds` is a comma-separated list. Omitted means every tenant; one id scopes to that
 * tenant; several compute a rollup across just those. `grain` overrides the bucket size the
 * server would otherwise pick from the window length — the page does not send it, so the
 * period control stays the only thing a reader has to think about.
 */
export const getMetricsSchema = z.object({
  params: z.object({}),
  body: z.object({}).passthrough().optional(),
  query: z.object({
    startDate: z.string().min(1).optional(),
    endDate: z.string().min(1).optional(),
    companyIds: z
      .string()
      .regex(/^\d+(,\d+)*$/, "companyIds must be a comma-separated list of numbers")
      .optional(),
    grain: z.enum(["hour", "day", "week"]).optional(),
  }),
});

/** GET /api/v1/metrics-smolorbig/companies — tenants for the company filter. */
export const listCompaniesSchema = z.object({
  params: z.object({}),
  body: z.object({}).passthrough().optional(),
  query: z.object({}).passthrough(),
});
