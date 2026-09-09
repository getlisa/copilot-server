import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Pins the QuickBooks WEBHOOK contract. Companion to check-qbo-auth.ts (the OAuth contract) and
 * check-qbo.ts (the estimate line mapping).
 *
 * Deliberately PURE — no database, no network. `npm test` runs inside the Docker build, where
 * neither exists, and a check script that needs them would fail the deploy rather than the build.
 *
 * What is worth pinning is what fails silently or dangerously in production:
 *  - the signature must verify against EITHER keyset's token, because one endpoint is registered
 *    on both, and it must report WHICH — nothing in the CloudEvent identifies the keyset;
 *  - it must accept base64 and hex, since Intuit's chosen encoding is undocumented;
 *  - it must fail CLOSED on a missing header, a tampered body, or a foreign token;
 *  - the retired legacy envelope must parse to zero events rather than throwing, so its arrival
 *    is a log line and a 200, not a crash;
 *  - the webhook router must be mounted BEFORE the global JSON parser — the HMAC is over raw
 *    bytes, and a refactor that reorders those two lines silently breaks every delivery.
 */

process.env.QBO_WEBHOOK_VERIFIER_TOKEN_SANDBOX = "sandbox-verifier-token";
process.env.QBO_WEBHOOK_VERIFIER_TOKEN_PRODUCTION = "production-verifier-token";

const sign = (body: string, token: string, encoding: "base64" | "hex") =>
  crypto.createHmac("sha256", token).update(Buffer.from(body, "utf8")).digest(encoding);

async function main() {
  const { verifierTokens, matchVerifierToken, parseQboEvents, STAGE_FOR_ENTITY, SUBSCRIBED_ENTITIES } =
    await import("../src/lib/qboWebhook");

  // ---- the two-keyset token set ----
  const tokens = verifierTokens();
  assert.deepStrictEqual(
    tokens.map((t) => t.name).sort(),
    ["production", "sandbox"],
    "one endpoint serves both keysets, so both tokens load"
  );
  assert.strictEqual(
    verifierTokens({ QBO_WEBHOOK_VERIFIER_TOKEN_SANDBOX: "only-one" } as NodeJS.ProcessEnv).length,
    1,
    "a single configured token is valid — the production one is unset until the flip"
  );
  assert.strictEqual(
    verifierTokens({ QBO_WEBHOOK_VERIFIER_TOKEN_SANDBOX: "   " } as NodeJS.ProcessEnv).length,
    0,
    "whitespace is not a token"
  );

  const body = JSON.stringify([
    {
      specversion: "1.0",
      id: "88cd52aa-33b6-4351-9aa4-47572edbd068",
      type: "qbo.estimate.updated.v1",
      time: "2026-09-10T21:31:25.179Z",
      intuitentityid: "1234",
      intuitaccountid: "9341452811589121",
      data: {},
    },
  ]);

  // ---- either keyset verifies, and the NAME comes back ----
  assert.strictEqual(
    matchVerifierToken(body, sign(body, "sandbox-verifier-token", "base64"), tokens),
    "sandbox"
  );
  assert.strictEqual(
    matchVerifierToken(body, sign(body, "production-verifier-token", "base64"), tokens),
    "production",
    "a production-keyset delivery must not 401 just because the server runs sandbox"
  );
  assert.strictEqual(
    matchVerifierToken(body, sign(body, "sandbox-verifier-token", "hex"), tokens),
    "sandbox",
    "hex is accepted: which encoding Intuit sends is undocumented"
  );

  // ---- fail closed ----
  assert.strictEqual(matchVerifierToken(body, undefined, tokens), null, "no header, no entry");
  assert.strictEqual(matchVerifierToken(body, "", tokens), null);
  assert.strictEqual(matchVerifierToken(body, "not-a-signature", tokens), null);
  assert.strictEqual(
    matchVerifierToken(body, sign(body, "someone-elses-token", "base64"), tokens),
    null,
    "a third token must not verify"
  );
  assert.strictEqual(
    matchVerifierToken(body + " ", sign(body, "sandbox-verifier-token", "base64"), tokens),
    null,
    "a tampered body must not verify"
  );
  assert.strictEqual(
    matchVerifierToken(body, sign(body, "sandbox-verifier-token", "base64"), []),
    null,
    "no tokens configured is never a PASS — the caller answers 503, not 401"
  );
  // Buffer and string must hash identically: the controller passes the raw Buffer.
  assert.strictEqual(
    matchVerifierToken(Buffer.from(body, "utf8"), sign(body, "sandbox-verifier-token", "base64"), tokens),
    "sandbox"
  );

  // ---- parsing ----
  const [event] = parseQboEvents(JSON.parse(body));
  assert.strictEqual(event.eventId, "88cd52aa-33b6-4351-9aa4-47572edbd068", "dedup key");
  assert.strictEqual(event.realmId, "9341452811589121", "the only tenant identifier");
  assert.strictEqual(event.entity, "estimate");
  assert.strictEqual(event.operation, "updated");
  assert.strictEqual(event.entityId, "1234");
  assert.strictEqual(event.rawType, "qbo.estimate.updated.v1", "Intuit's own string is kept");

  const ev = (type: string, extra: Record<string, unknown> = {}) => ({
    id: "e1",
    intuitaccountid: "r1",
    type,
    ...extra,
  });

  // Every subscribed entity resolves, and each maps to a stage (estimate deliberately to none).
  for (const entity of SUBSCRIBED_ENTITIES) {
    const [p] = parseQboEvents([ev(`qbo.${entity}.created.v1`)]);
    assert.strictEqual(p.entity, entity, `${entity} is subscribed`);
    assert.ok(entity in STAGE_FOR_ENTITY, `${entity} has a stage mapping`);
  }
  assert.strictEqual(STAGE_FOR_ENTITY.estimate, null, "estimates have no ingest stage");
  assert.strictEqual(STAGE_FOR_ENTITY.taxagency, "salesTax", "TaxAgency triggers a tax re-read");
  assert.strictEqual(STAGE_FOR_ENTITY.customer, "customers");

  // An unsubscribed entity is still RECORDED (entity null), never dropped and never an error.
  const [unsub] = parseQboEvents([ev("qbo.vendor.created.v1")]);
  assert.strictEqual(unsub.entity, null);
  assert.strictEqual(unsub.operation, "created");

  // Every operation is subscribed and the vocabulary is not fully documented, so anything at all
  // must survive parsing — the processor treats an unknown operation as "refetch".
  for (const op of ["created", "updated", "deleted", "merged", "voided", "emailed", "surprise"]) {
    const [p] = parseQboEvents([ev(`qbo.customer.${op}.v1`)]);
    assert.strictEqual(p.operation, op, `operation ${op} is kept verbatim`);
  }
  assert.strictEqual(parseQboEvents([ev("qbo.customer")])[0].operation, "unknown");

  // Noise yields an empty array rather than an exception. Answering 200 depends on this.
  assert.deepStrictEqual(parseQboEvents(null), []);
  assert.deepStrictEqual(parseQboEvents({}), []);
  assert.deepStrictEqual(parseQboEvents("[]"), []);
  assert.deepStrictEqual(parseQboEvents([null, 7, "x"]), []);
  assert.deepStrictEqual(parseQboEvents([{ id: "e1" }]), [], "no realm, cannot route");
  assert.deepStrictEqual(parseQboEvents([{ intuitaccountid: "r1" }]), [], "no id, cannot dedup");
  assert.deepStrictEqual(
    parseQboEvents({
      eventNotifications: [
        { realmId: "r1", dataChangeEvent: { entities: [{ name: "Customer", id: "1" }] } },
      ],
    }),
    [],
    "the retired legacy envelope is a log line and a 200, not a crash"
  );

  // A numeric intuitentityid must not become the string "undefined" or throw.
  assert.strictEqual(parseQboEvents([ev("qbo.item.created.v1", { intuitentityid: 42 })])[0].entityId, "42");
  assert.strictEqual(parseQboEvents([ev("qbo.item.created.v1")])[0].entityId, null);

  // ---- the mount order, which is load-bearing ----
  const server = fs.readFileSync(path.join(__dirname, "../src/server.ts"), "utf8");
  const rawMount = server.indexOf('app.use("/api/v1/webhooks"');
  const jsonParser = server.indexOf("express.json({");
  assert.ok(rawMount > -1, "the webhook router is mounted");
  assert.ok(
    rawMount < jsonParser,
    "the webhook router MUST be mounted before express.json — the HMAC is over raw bytes, and " +
      "the global parser keeps no raw copy"
  );
  assert.ok(
    /app\.use\("\/api\/v1\/webhooks",\s*express\.raw\(\{\s*type:\s*"\*\/\*"/.test(server),
    'the raw parser must match "*/*": CloudEvents can arrive as application/cloudevents-batch+json'
  );

  console.log("check-qbo-webhook: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
