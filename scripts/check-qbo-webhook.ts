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
  const {
    verifierTokens,
    matchVerifierToken,
    parseQboEvents,
    STAGE_FOR_ENTITY,
    SUBSCRIBED_ENTITIES,
    mergeOutcome,
    stagesForEntities,
    backoffMs,
    unparseableEventId,
    MAX_ATTEMPTS,
    OUTCOME_RANK,
    estimateDriftVerdict,
    estimateEventAction,
    ESTIMATE_ACTION_RANK,
  } = await import("../src/lib/qboWebhook");

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
  assert.strictEqual(STAGE_FOR_ENTITY.account, "accounts");
  assert.strictEqual(STAGE_FOR_ENTITY.item, "items");

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

  // ---- drain arithmetic (extracted so it is reachable without a database) ----

  const oc = (
    status: "done" | "skipped" | "failed" | "queued",
    error?: string,
    attempts?: number,
    doneCompanies: number[] = []
  ) => ({ status, error, attempts, doneCompanies });

  // Precedence: a row must come back if ANY company still owes work on it.
  assert.ok(OUTCOME_RANK.queued > OUTCOME_RANK.failed, "a retry outranks giving up");
  assert.ok(OUTCOME_RANK.failed > OUTCOME_RANK.done);
  assert.ok(OUTCOME_RANK.done > OUTCOME_RANK.skipped, "real work outranks nothing-to-do");
  assert.strictEqual(mergeOutcome(undefined, oc("done")).status, "done");
  assert.strictEqual(mergeOutcome(oc("done"), oc("skipped")).status, "done");
  assert.strictEqual(mergeOutcome(oc("skipped"), oc("done")).status, "done");
  assert.strictEqual(mergeOutcome(oc("done"), oc("queued")).status, "queued");

  // THE REGRESSION THIS EXISTS FOR. A busy sibling recorded first must not swallow a real
  // failure's attempt count: with attempts never written, MAX_ATTEMPTS was never reached and the
  // row retried every 10 seconds forever with no error recorded to explain it.
  const busyThenFail = mergeOutcome(oc("queued"), oc("queued", "boom", 3));
  assert.strictEqual(busyThenFail.attempts, 3, "an equal-rank merge must keep the attempt bump");
  assert.strictEqual(busyThenFail.error, "boom", "and must keep the error");
  const failThenBusy = mergeOutcome(oc("queued", "boom", 3), oc("queued"));
  assert.strictEqual(failThenBusy.attempts, 3, "order must not change the outcome");
  assert.strictEqual(failThenBusy.error, "boom");
  // Attempts never go backwards, whichever order they arrive in.
  assert.strictEqual(mergeOutcome(oc("queued", "a", 4), oc("queued", "b", 2)).attempts, 4);
  assert.strictEqual(mergeOutcome(oc("queued", "a", 2), oc("queued", "b", 4)).attempts, 4);

  // A completed company stays completed even when a sibling requeues the row.
  const fanout = mergeOutcome(oc("done", undefined, undefined, [7]), oc("queued", "b", 1, []));
  assert.strictEqual(fanout.status, "queued", "the row returns for the company still owed");
  assert.deepStrictEqual(fanout.doneCompanies, [7], "but company 7 is not redone");
  assert.deepStrictEqual(
    mergeOutcome(oc("done", undefined, undefined, [7]), oc("done", undefined, undefined, [9]))
      .doneCompanies,
    [7, 9]
  );

  // Stage coalescing, including the tax pairing Preferences would otherwise have covered.
  assert.deepStrictEqual(stagesForEntities(["customer", "customer"]), ["customers"], "deduped");
  assert.deepStrictEqual(stagesForEntities(["estimate"]), [], "estimates have no stage");
  assert.deepStrictEqual(stagesForEntities([null]), []);
  assert.ok(stagesForEntities(["taxagency"]).includes("taxPrefs"), "tax re-reads TaxPrefs too");
  assert.ok(stagesForEntities(["taxagency"]).includes("salesTax"));
  assert.strictEqual(new Set(stagesForEntities(["customer", "item", "account"])).size, 3);

  // Backoff has to outlast a QuickBooks throttle window; a flat 10s interval did not.
  assert.ok(backoffMs(1) >= 30_000, "first retry waits at least 30s");
  assert.ok(backoffMs(2) > backoffMs(1), "and grows");
  assert.ok(backoffMs(4) > 20 * 60_000, "by the 4th attempt it is well past a throttle window");
  assert.ok(backoffMs(99) <= 2 * 60 * 60 * 1000, "but is capped");
  // 30s + 2m + 8m + 32m = 42.5 minutes across the four waits before the fifth and final attempt.
  // The number that matters is the comparison: the old fixed 10s interval spent all five attempts
  // inside 50 seconds, so any QuickBooks outage longer than that exhausted the row permanently.
  let span = 0;
  for (let a = 1; a < MAX_ATTEMPTS; a++) span += backoffMs(a);
  assert.ok(span > 40 * 60 * 1000, `retry budget spans ${Math.round(span / 60000)}min, want >40`);
  assert.ok(span < 4 * 60 * 60 * 1000, "but a stale refresh is worse than a slow one");

  // A redelivery of the same unreadable body must collapse onto one row.
  assert.strictEqual(unparseableEventId("abc"), unparseableEventId(Buffer.from("abc")));
  assert.notStrictEqual(unparseableEventId("abc"), unparseableEventId("abd"));
  assert.ok(unparseableEventId("abc").startsWith("unparseable:"));

  // ---- the mount order, which is load-bearing ----
  // COMMENTS ARE STRIPPED FIRST. Without that, commenting the mount out left the literal text in
  // place, indexOf still found it, and all three assertions passed while every delivery 404'd —
  // a silent-pass guard against a silent break, which is the one thing a guard must never be.
  // Line-level, NOT a block-comment regex. The obvious `/\*[\s\S]*?\*\//g` strip is actively
  // wrong here: `express.raw({ type: "*/*" })` contains `*/` immediately followed by `/*`, so the
  // regex closes on the string literal and then swallows the very line it is meant to check. A
  // guard that deletes its own subject is worse than no guard.
  const serverSrc = fs
    .readFileSync(path.join(__dirname, "../src/server.ts"), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

  const rawMount = serverSrc.indexOf('app.use("/api/v1/webhooks/qbo"');
  const jsonParser = serverSrc.indexOf("express.json({");
  assert.ok(rawMount > -1, "the webhook router is mounted (and not commented out)");
  assert.ok(jsonParser > -1, "the global JSON parser is still installed");
  assert.ok(
    rawMount < jsonParser,
    "the webhook router MUST be mounted before express.json — the HMAC is over raw bytes, and " +
      "the global parser keeps no raw copy"
  );
  assert.ok(
    /app\.use\("\/api\/v1\/webhooks\/qbo",\s*express\.raw\(\{\s*type:\s*"\*\/\*"/.test(serverSrc),
    'the raw parser must match "*/*": CloudEvents can arrive as application/cloudevents-batch+json'
  );
  // Prove the strip actually bites, so this guard cannot rot back into a text match.
  // Prove the filter actually bites, so this guard cannot rot back into a plain text match.
  const strip = (src: string) =>
    src
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
  const commentedOut = strip(
    serverSrc
      .split("\n")
      .map((l) => (l.includes('app.use("/api/v1/webhooks/qbo"') ? "// " + l : l))
      .join("\n")
  );
  assert.strictEqual(
    commentedOut.indexOf('app.use("/api/v1/webhooks/qbo"'),
    -1,
    "a commented-out mount must not satisfy this check"
  );

  // ---- estimate drift: telling the client's edit from the echo of our own write ----
  // The whole point of storing a SyncToken. Getting any of these backwards is either a warning
  // that never fires (re-completion silently overwrites the client's edit) or one that always
  // does (people learn to ignore it).
  assert.strictEqual(
    estimateDriftVerdict("3", "3", false),
    "unchanged",
    "matching tokens are the echo of our own post, not a drift"
  );
  assert.strictEqual(
    estimateDriftVerdict("3", "4", false),
    "drift",
    "a token past ours means somebody edited the estimate inside QuickBooks"
  );
  assert.strictEqual(
    estimateDriftVerdict("3", "4", true),
    "already-flagged",
    "the stamp records when drift was FIRST seen; a second edit must not move it"
  );
  assert.strictEqual(
    estimateDriftVerdict(null, "7", false),
    "baseline",
    "no stored token is UNKNOWN, not drift — adopt what QuickBooks reports"
  );
  assert.strictEqual(
    estimateDriftVerdict("3", null, false),
    "skip",
    "no remote token means nothing to compare"
  );
  // Intuit documents SyncToken as a numeric string and has been seen sending a JSON number.
  // Comparing those by identity would report drift on every single event.
  assert.strictEqual(
    estimateDriftVerdict("3", 3 as unknown as string, false),
    "unchanged",
    "a numeric 3 and a string \"3\" are the same token"
  );
  // A token that went BACKWARDS is still a difference, and still not ours.
  assert.strictEqual(
    estimateDriftVerdict("9", "2", false),
    "drift",
    "drift is inequality, not ordering — a lower token is still not the one we wrote"
  );

  // ---- estimate event routing: `emailed` is not an edit ----
  // Every operation is subscribed, so sending an estimate from inside QuickBooks delivers
  // estimate.emailed — and it writes EmailStatus, which bumps SyncToken exactly like a real edit.
  // Comparing it would stamp "changed in QuickBooks" on every email the client sends.
  assert.strictEqual(estimateEventAction("Delete"), "delete", "a delete clears the stored id");
  assert.strictEqual(estimateEventAction("Emailed"), "ignore", "emailing is not an edit");
  assert.strictEqual(estimateEventAction("emailed"), "ignore", "operation case must not matter");
  assert.strictEqual(estimateEventAction("Update"), "compare", "an update is compared");
  // The §3.5 rule: an operation nobody has seen must still be re-read, never silently dropped.
  assert.strictEqual(
    estimateEventAction("SomethingIntuitAddsLater"),
    "compare",
    "an unknown operation on a known entity must still be compared, not ignored"
  );

  // An undefined token must not reach the string comparison — `String(undefined)` vs "3" is a
  // false drift produced by a missing field rather than a real edit.
  assert.strictEqual(
    estimateDriftVerdict("3", undefined as unknown as string, false),
    "skip",
    "an absent remote token is nothing to compare, not a drift"
  );
  assert.strictEqual(
    estimateDriftVerdict(undefined as unknown as string, "3", false),
    "baseline",
    "an absent stored token is UNKNOWN, not a drift"
  );

  // Coalescing several events for one estimate in a pass: a delete is terminal, and a real
  // compare must never be masked by an `emailed` delivered alongside it.
  assert.ok(
    ESTIMATE_ACTION_RANK.delete > ESTIMATE_ACTION_RANK.compare,
    "a delete outranks a compare — the estimate is gone, the read could only 404"
  );
  assert.ok(
    ESTIMATE_ACTION_RANK.compare > ESTIMATE_ACTION_RANK.ignore,
    "a compare outranks an ignore — an email must not mask a genuine edit in the same window"
  );

  console.log("check-qbo-webhook: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
