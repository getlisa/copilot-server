import { Router } from "express";
import { MetricsController } from "../controllers/metrics.controller";
import { validate } from "../middlewares/validate";
import { withValidatedRequest } from "../middlewares/withValidatedRequest";
import { authMiddleware } from "../middlewares/auth";
import { getMetricsSchema } from "../schemas/metrics.schema";

/**
 * Estimating Agent metrics, read by the unlinked /metrics-smolorbig page.
 *
 * Cross-tenant quote values live behind this route, so every path needs a real token. The
 * page being unlinked is not the control — the role check in the controller is: admin or
 * service manager to read at all, admin alone to look past their own company.
 */
const metricsRoute = Router();

metricsRoute.use(authMiddleware);

metricsRoute.get(
  "/",
  validate(getMetricsSchema),
  withValidatedRequest(MetricsController.getMetrics)
);

// No query, params or body — nothing to validate.
metricsRoute.get("/companies", MetricsController.listCompanies);

export { metricsRoute };
