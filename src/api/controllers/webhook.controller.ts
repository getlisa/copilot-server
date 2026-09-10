import { Request, Response } from "express";
import logger from "../../lib/logger";
import {
  matchVerifierToken,
  parseQboEvents,
  verifierTokens,
} from "../../lib/qboWebhook";
import {
  recordQboWebhookEvents,
  recordUnparseableDelivery,
} from "../../lib/qboWebhookProcessor";

/**
 * POST /api/v1/webhooks/qbo — inbound QuickBooks Online CloudEvents.
 *
 * Verify, record, 200. All real work happens in the drain (lib/qboWebhookProcessor), because
 * Intuit expects a prompt response and gives up after a finite number of retries.
 *
 * STATUS SEMANTICS, and they are the whole rule:
 *   200 for anything wrong with THEIR data — unknown realm, an entity we do not subscribe to, a
 *       duplicate event, the retired legacy envelope. Every tenant shares this one endpoint, so a
 *       5xx for one tenant's junk risks the subscription for all of them.
 *   503 only for OUR infrastructure failing, where Intuit's redelivery is the sole recovery.
 *   401 only for a signature that genuinely does not match.
 * "Always 200" is too blunt and costs an event-loss path; "401 when unsure" is worse, because it
 * tells Intuit our credentials are wrong, which is the response most likely to get a subscription
 * disabled rather than retried.
 *
 * `req.body` is a Buffer here: the router is mounted with express.raw BEFORE the global JSON
 * parser, because the HMAC is over the exact bytes Intuit sent and the global parser keeps no
 * raw copy.
 */
export const WebhookController = {
  async qbo(req: Request, res: Response) {
    const contentType = (req.headers["content-type"] as string) ?? null;
    const contentLength = Number(req.headers["content-length"] ?? 0);
    const rawBody: Buffer | undefined = Buffer.isBuffer(req.body) ? req.body : undefined;

    if (!rawBody || rawBody.length === 0) {
      if (contentLength > 0) {
        // Intuit sent a body and we failed to capture the bytes — our bug, not their data. 503 so
        // they redeliver, rather than 200-ing away a real event. This is the failure that
        // rejected collections' first live deliveries: their raw-body middleware matched only
        // `application/json`, and CloudEvents can arrive as application/cloudevents-batch+json.
        logger.error("QBO webhook: body present but raw bytes not captured", {
          content_type: contentType,
          content_length: contentLength,
        });
        return res.status(503).json({
          success: false,
          error: { status: 503, message: "Could not read body; please redeliver" },
        });
      }
      // Genuinely empty: Intuit validating the endpoint. A 4xx here can fail that validation and
      // disable the subscription.
      logger.info("QBO webhook probe with empty body (endpoint validation)", {
        content_type: contentType,
      });
      return res.status(200).json({ received: 0, recorded: 0 });
    }

    // ── Signature first. No database write of any kind before this passes. ──
    // Writing first lets a replayed or forged body create unauthenticated rows.
    const tokens = verifierTokens();
    if (tokens.length === 0) {
      // OUR failure (the secret never reached the task definition), not a bad signature.
      logger.error("Cannot verify QBO webhook: no verifier token configured", {
        expected: "QBO_WEBHOOK_VERIFIER_TOKEN_SANDBOX / _PRODUCTION",
      });
      return res.status(503).json({
        success: false,
        error: { status: 503, message: "Verifier token unavailable; please redeliver" },
      });
    }

    const signature = req.headers["intuit-signature"] as string | undefined;
    const keyset = matchVerifierToken(rawBody, signature, tokens);
    if (!keyset) {
      // The source address matters here in a way it does not on an authenticated route: this is
      // the one endpoint whose expected caller is an unauthenticated stranger, so a burst of
      // rejections is the only signal that someone is probing it. `trust proxy` is unset, so the
      // ALB's client address arrives in x-forwarded-for; log both.
      logger.warn("Rejected QBO webhook: invalid signature", {
        signature_present: !!signature,
        body_bytes: rawBody.length,
        tokens_tried: tokens.map((t) => t.name),
        ip: req.ip,
        forwarded_for: req.headers["x-forwarded-for"],
      });
      return res.status(401).json({
        success: false,
        error: { status: 401, message: "Invalid signature" },
      });
    }

    // A delivery that passed the signature but cannot be read is PERSISTED, not just logged.
    // These are verified bytes from Intuit; discarding them leaves nothing in the table to show
    // the feed went dark, and "no rows arrived" then looks identical to "nothing changed".
    // `select count(*) from qbo_webhook_events where operation = 'unparseable'` answers it.
    const unreadable = async (reason: string) => {
      logger.info(reason, { keyset, content_type: contentType, body_bytes: rawBody.length });
      try {
        await recordUnparseableDelivery(rawBody, keyset);
      } catch (error) {
        // Best effort: the delivery itself is still acknowledged, because a 5xx here would ask
        // Intuit to redeliver a body we already know we cannot read.
        logger.error("Could not record an unparseable QBO delivery", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return res.status(200).json({ received: 0, recorded: 0 });
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return unreadable("QBO webhook body was not JSON");
    }

    const events = parseQboEvents(parsed);
    if (events.length === 0) {
      // An empty batch, or a shape we do not recognise (e.g. the retired legacy envelope).
      return unreadable("QBO webhook contained no usable CloudEvents");
    }

    // The global request logger sits AFTER express.json(), so this router answers without ever
    // reaching it. Everything worth knowing has to be logged here — and until the processing
    // phases land, these lines ARE the deliverable: they are how we learn Intuit's real operation
    // vocabulary, especially for `estimate`, which no documentation states.
    logger.info("QBO webhook received", {
      keyset,
      content_type: contentType,
      count: events.length,
      events: events.map((e) => ({
        type: e.rawType,
        realm: e.realmId,
        entity_id: e.entityId,
        time: e.eventTime,
        subscribed: !!e.entity,
      })),
    });

    try {
      const recorded = await recordQboWebhookEvents(events, keyset);
      if (recorded < events.length)
        logger.info("QBO webhook redelivery ignored", {
          received: events.length,
          recorded,
        });
      return res.status(200).json({ received: events.length, recorded });
    } catch (error) {
      // The database is ours. Intuit's redelivery is the only thing that can recover the events,
      // and the unique event_id makes that redelivery safe: whatever did land dedupes on retry.
      logger.error("Failed to record QBO webhook events", {
        keyset,
        count: events.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(503).json({
        success: false,
        error: { status: 503, message: "Temporary failure; please redeliver" },
      });
    }
  },
};
