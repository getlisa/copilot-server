import { Router, type NextFunction, type Request, type Response } from "express";
import { WebhookController } from "../controllers/webhook.controller";
import logger from "../../lib/logger";

/**
 * Inbound third-party webhooks.
 *
 * DELIBERATELY UNAUTHENTICATED, and the credential is the payload signature instead. Intuit posts
 * server-to-server with no bearer token; `intuit-signature` is an HMAC over the raw body keyed
 * with a verifier token only Intuit and this server hold, and the controller refuses everything
 * that does not match it.
 *
 * The raw-body parser is applied at the MOUNT in server.ts, not here, because it has to displace
 * the global JSON parser for this path — see the comment there.
 */
const webhookRoute = Router();

webhookRoute.post("/qbo", WebhookController.qbo);

/**
 * Scoped error handler, and it exists to keep one promise the controller makes.
 *
 * A body-parser failure — an oversized or truncated delivery — calls `next(createError(400))`,
 * which reaches the app-wide handler in server.ts. That handler answers 500 unconditionally,
 * regardless of the thrown error's own status, so the documented status contract ("503 for our
 * infrastructure, and only that") was quietly untrue for the one case Intuit is most likely to
 * hit on a bad connection. Both are 5xx so the retry behaviour was already right; the code was
 * not, and 500 in the logs is indistinguishable from an application crash.
 */
webhookRoute.use((err: Error & { status?: number }, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  logger.error("QBO webhook body could not be read", {
    status: err.status,
    error: err.message,
    content_length: req.headers["content-length"],
    ip: req.ip,
  });
  res.status(503).json({
    success: false,
    error: { status: 503, message: "Could not read body; please redeliver" },
  });
});

export default webhookRoute;
