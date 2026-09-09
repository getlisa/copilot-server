import { Router } from "express";
import { WebhookController } from "../controllers/webhook.controller";

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

export default webhookRoute;
