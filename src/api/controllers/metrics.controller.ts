import { Response } from "express";
import { ValidatedRequest } from "../middlewares/validate";
import { RequestWithUser, isAdminRole } from "../middlewares/auth";
import logger from "../../lib/logger";
import { metricsService, MetricsService } from "../services/metrics.service";
import { MetricGrain } from "../services/metrics.types";
import { getMetricsSchema } from "../schemas/metrics.schema";

type GetMetricsRequest = ValidatedRequest<typeof getMetricsSchema> & RequestWithUser;
type ListCompaniesRequest = RequestWithUser;

/**
 * Only an admin may look beyond their own tenant. A service manager reads metrics, but for
 * the company they belong to — these numbers are quote values and technician activity, and
 * one client's are not another's to see.
 */
const CROSS_TENANT_ROLES = ["admin"];

const DEFAULT_WINDOW_DAYS = 30;

function parseDate(value: string | undefined, fallback: Date): Date | null {
  if (!value) return fallback;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function deny(res: Response, status: number, message: string) {
  return res.status(status).json({ data: null, error: { status, message } });
}

export class MetricsController {
  /**
   * GET /api/v1/metrics-smolorbig
   *
   * Computed for this request, every time. See metrics.service.ts for why there is no rollup
   * to read instead.
   */
  static async getMetrics(req: GetMetricsRequest, res: Response) {
    try {
      const user = req.user;
      if (!user || !isAdminRole(user.role)) {
        return deny(res, 403, "Access denied. Admin or service manager role required.");
      }

      const { startDate, endDate, companyIds, grain } = req.validated.query;

      const end = parseDate(endDate, new Date());
      if (!end) {
        return deny(res, 400, "Invalid endDate. Use ISO 8601, for example 2026-10-12.");
      }

      const defaultStart = new Date(end);
      defaultStart.setDate(defaultStart.getDate() - DEFAULT_WINDOW_DAYS);

      const start = parseDate(startDate, defaultStart);
      if (!start) {
        return deny(res, 400, "Invalid startDate. Use ISO 8601, for example 2026-09-12.");
      }
      if (start > end) {
        return deny(res, 400, "startDate must be on or before endDate.");
      }

      const requested = companyIds
        ? companyIds
            .split(",")
            .map((v) => Number(v))
            .filter((n) => Number.isFinite(n))
        : undefined;

      // A non-admin is pinned to their own company whatever they ask for. Refused rather than
      // silently narrowed: a service manager who asked for three tenants and got one would
      // read the answer as those three.
      let scoped: number[] | undefined;
      if (CROSS_TENANT_ROLES.includes(user.role)) {
        scoped = requested;
      } else {
        if (requested && requested.some((id) => id !== user.companyId)) {
          return deny(res, 403, "Access denied. You can only read metrics for your own company.");
        }
        scoped = [user.companyId];
      }

      const effectiveGrain: MetricGrain =
        (grain as MetricGrain) ?? MetricsService.grainFor(start, end);

      const result = await metricsService.getSeries({
        startDate: start,
        endDate: end,
        companyIds: scoped,
        grain: effectiveGrain,
      });

      return res.json({
        data: {
          range: { startDate: start.toISOString(), endDate: end.toISOString() },
          companyIds: scoped ?? null,
          grain: result.grain,
          // When the figures were read. A tab left open all afternoon should be able to say
          // how old what it is showing is.
          generatedAt: result.generatedAt,
          sections: result.sections,
        },
      });
    } catch (error) {
      logger.error("[Metrics] getMetrics failed", { error });
      return deny(res, 500, "Failed to read metrics");
    }
  }

  /** GET /api/v1/metrics-smolorbig/companies — tenants for the company filter. */
  static async listCompanies(req: ListCompaniesRequest, res: Response) {
    try {
      const user = req.user;
      if (!user || !isAdminRole(user.role)) {
        return deny(res, 403, "Access denied. Admin or service manager role required.");
      }

      const companies = await metricsService.listCompanies();

      // A service manager sees one entry — their own — so the filter renders but cannot be
      // used to reach another tenant.
      const visible = CROSS_TENANT_ROLES.includes(user.role)
        ? companies
        : companies.filter((c) => c.id === user.companyId);

      return res.json({ data: visible });
    } catch (error) {
      logger.error("[Metrics] listCompanies failed", { error });
      return deny(res, 500, "Failed to list companies");
    }
  }
}
