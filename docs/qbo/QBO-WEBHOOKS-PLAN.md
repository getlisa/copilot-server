# QuickBooks webhooks — plan

**Closes gap #10 / T-29:** *"Nothing flows QuickBooks → CLARA. An estimate edited or accepted
inside QuickBooks never reaches CLARA, and the update-in-place path would overwrite that edit on
the next re-completion."*

- **Written:** 2026-09-09, against `copilot-server` `origin/main` `5632c1a` and
  `technician-copilot` `origin/main` `39876fc` (both fetched, both clean/up to date).
- **Companions:** `QBO-INTEGRATION.md` (chronology). `QBO-ARCHITECTURE.md` (system as it stands) was
  present and **untracked** when this plan was written, and **disappeared from the working tree
  during the session** — it is in no commit and no stash, so git cannot restore it. Everything
  this plan quotes from it is reproduced inline; nothing below depends on it existing.
- **Reference implementation:** `~/clara/collection_agent_backend` —
  `docs/qbo-webhooks-design.md`, `src/api/webhooks/qbo.ts`, `src/services/qbo-webhook/*`.
  Shipped and running against a **production** realm since 2026-08-24. Its payload findings are
  the only fully trustworthy source on the CloudEvents format, because Intuit's own docs are a
  JS SPA that is not machine-readable.

---

## 0. Registered in the Intuit portal — done 2026-09-09

| | |
|---|---|
| Endpoint URL | `https://techcopilot-assistant.justclara.ai/api/v1/webhooks/qbo` |
| Keysets | **Both** — the same URL on Development *and* Production |
| Payload format | **CloudEvents** |
| Entities | Account, Customer, Estimate, Item, **TaxAgency** |
| Operations | all, on every entity |

That host is the ECS backend (`techcopilot-prod-assistant`), already public over HTTPS and already
the host on the registered QBO redirect URI. `/api/v1/...` matches every other mount in
`server.ts`.

### 0.1 One URL on two keysets ⇒ **two verifier tokens, and the receiver must accept either**

This is the one decision that changes code, so it is first. Intuit issues a **separate verifier
token per keyset**, and both keysets now point at one endpoint. A receiver holding a single token
401s every delivery from the other keyset — and a 401 is the response most likely to get a
subscription disabled rather than retried (§2).

So there are **two named tokens**, not one:

```
QBO_WEBHOOK_VERIFIER_TOKEN_SANDBOX=…
QBO_WEBHOOK_VERIFIER_TOKEN_PRODUCTION=…
```

Named rather than a comma-separated list, deliberately: the receiver logs **which one matched**,
and `"sandbox"` is a useful log line where `"token[0]"` is not. It is the only thing that
identifies the keyset an event came from — nothing in the CloudEvent does. Verify against each in
turn with `timingSafeEqual`; **neither** set ⇒ 503, never 401. Two HMACs per delivery costs
microseconds.

**Both are in the local `.env` already** (gitignored, confirmed by `git check-ignore`; the file is
untracked). `.env.example` documents the two key names with empty values.

Accepting both is not a weakening: each is a secret Intuit issued to *this* app, and the endpoint
genuinely serves both keysets. Set the production token now even though nothing uses it yet —
otherwise the sandbox→production flip silently starts 401ing.

**What the choice buys.** The flip no longer needs a portal round-trip for webhooks: register
once, and the URL is already right on both sides. That is a good trade for one extra env var.

**What it means today.** `qboConnected(conn)` requires `conn.environment === QBO_ENVIRONMENT`, and
the server runs `sandbox`. Production-keyset deliveries will therefore resolve to **zero
connections → `skipped`, 200**. That is correct, not a bug — no company has production tokens
because Connect mints on the sandbox keyset — but it means the Production subscription is inert
until the flip, and the plan should not be read as though it were live.

### 0.2 What the entity selection settles, and what it leaves open

**Account, Customer, Item, Estimate** are exactly the mirrors this repo keeps
(`raw_account_qb`, `customers`/`customer_qb`, `qbo_item_links`/`raw_item_qb`, and — Phase 3 —
`Quote.qboEstimateId`). Nothing to reconsider.

**TaxAgency is the right pick given what Intuit offers, and it is a partial signal — say so out
loud.** `ingestSalesTax` reads **`TaxCode` and `TaxRate`**, never TaxAgency, and neither of those
is a webhook entity. So a TaxAgency event is a *trigger to re-read tax*, not data — the handler
re-runs the whole `salesTax` stage. It fires when an **agency** is added or changed, which is what
happens the first time a company sets up tax in a new jurisdiction. It will **not** fire when a
rate changes under an agency that already exists. Sales-tax freshness is therefore improved, not
guaranteed, and the manual Sync button stays the backstop. Worth a line on the Connections card
rather than a claim we cannot keep.

**Preferences was not selected, so Automated Sales Tax detection stays manual.** `ingestTaxPrefs`
reads `Preferences.TaxPrefs` onto `qbo_connections.using_sales_tax` / `partner_tax_enabled`, and
under AST Intuit *ignores* `TxnTaxCodeRef` and computes from the address — which makes the entire
snapshot tax model cosmetic. Today nothing notices until a signed proposal disagrees with the
books. Cheap mitigation, and Phase 2 does it: **piggyback `ingestTaxPrefs` on the TaxAgency
handler**, since a company turning on AST is overwhelmingly likely to touch its agencies in the
same sitting. If Preferences *is* offered in the portal, ticking it is strictly better; check
while you are next in there.

**All operations, on every entity** means `delete`, `merge`, `void` and `emailed` arrive too. The
"unknown operation ⇒ refetch" rule (§3.5) covers every one of them without an enum, and §3.4
explains why `customer.merge` — the case collections explicitly refused to guess — is handled
correctly here for free.

### 0.3 Still outstanding for Bharath

**Both verifier tokens into `techcopilot/prod/app`.** Received 2026-09-09 and written to the local
`.env` (gitignored, `git check-ignore` confirmed, file untracked). The production secret is the
step that remains, and it is scripted:

```
bash scripts/set-qbo-webhook-env.sh            # dry run — prints the plan, writes nothing
bash scripts/set-qbo-webhook-env.sh --apply    # does it
```

It reads the values from `.env` and never prints them (key names, counts and a sha256 prefix
only), merges the two keys into the secret **without overwriting** anything, registers a task
definition revision carrying both references, moves the service onto it and waits for stable. It
is idempotent — run twice and the second run exits saying there is nothing to do.

**The third step is not optional, and this is the part worth understanding.** The pipeline's ECS
deploy action derives each new revision from the task definition **the service is currently
running**, swapping only the image. A revision that is registered and left unused is orphaned:
the next deploy bases off the old one and the two variables silently vanish. They must be on the
running revision *before* the webhook image ships. T-15 hit exactly this and did
register-then-update as two steps.

It is a production redeploy, but a functionally inert one — same image, two variables the
currently deployed code does not read.

*Probed 2026-09-09, so the script's constants are facts rather than guesses:* secret
`techcopilot/prod/app` (ARN suffix `-qRY1HD`) holds **30** keys, six of them `QBO_*`; the service
runs **`techcopilot-prod-assistant:105`**, 1/1 ACTIVE, container `assistant` with 25 secrets in
the `<secret-arn>:KEY::` form. Note both numbers have moved since `QBO-ARCHITECTURE.md` was
written (it says 29 keys and `:101`).

The script lives in `scripts/` **on purpose**: its predecessor, credited in `QBO-INTEGRATION.md`
as `scratchpad/set-qbo-env.sh` for the T-15 merge, was written to a per-session scratchpad and is
gone, so the one documented way to do this had to be reconstructed from an AWS probe.

**Verify with one real delivery as soon as the revision is live.** A *mis-pasted* token 401s every
event, which is the response §2 spends a paragraph explaining gets a subscription disabled. The
503 path only covers a token that is *missing*.

**If the portal probed the URL on save and accepted it**, nothing answers there yet and Phase 1
still needs shipping before any delivery is retained. Deliveries made before Phase 1 is live are
lost — Intuit retries for a finite window, not forever. Not a problem: there is nothing in the
sandbox generating events until someone edits something.

---

## 1. What the delivery actually looks like

Not the legacy `eventNotifications[].dataChangeEvent.entities[]` envelope that every tutorial
still describes — that was retired at the CloudEvents deadline (extended once, to 2026-07-31;
long past). Deliveries are a **top-level JSON array** of CloudEvents:

```json
[{
  "specversion": "1.0",
  "id": "88cd52aa-33b6-4351-9aa4-47572edbd068",
  "source": "intuit.dsnBgbse…",
  "type": "qbo.estimate.updated.v1",
  "time": "2026-09-10T21:31:25.179Z",
  "intuitentityid": "1234",
  "intuitaccountid": "9341452811589121",
  "data": {}
}]
```

Four consequences that shape everything below:

| Field | Consequence |
|---|---|
| `id` | The dedup key. Redeliveries repeat it verbatim. |
| `type` | Entity **and** operation are segments of one string, split on `.`. |
| `intuitaccountid` | The **only** tenant identifier — the realm. Drives realm → company. |
| `data` | **Empty.** A webhook is a pointer, never a payload. Every event costs a QBO API read. |

One delivery can carry events for **multiple realms**, and because we always re-fetch current
state, **out-of-order delivery is harmless** — we read truth, not a diff.

---

## 2. Phase 1 — the receiver, and nothing else. Ship this first.

Verify the signature, write the raw event to a log line, answer 200. No database, no processing,
no QBO reads.

That is not a placeholder, it is the point: **nobody knows Estimate's operation vocabulary.**
Does accepting an estimate in QuickBooks fire `qbo.estimate.updated.v1`, or nothing at all? Does
converting one to an invoice fire on the estimate, or only on the new invoice? Intuit's docs will
not answer that and neither will guessing. A day of real sandbox deliveries will, and Phase 2's
handler table is written against what we observe rather than what we assume. Collections took
exactly this route on 2026-08-24 and it settled three things its first draft had guessed wrong.

**Files**

| File | Content |
|---|---|
| `src/api/routes/webhook.route.ts` | Mounts the QBO handler. |
| `src/api/controllers/webhook.controller.ts` | The handler below. |
| `src/lib/qboWebhook.ts` | `verifyQboSignature` + `parseQboEvents`, ported from collections. |
| `scripts/check-qbo-webhook.ts` | Assertions, wired into `npm test`. |
| `src/server.ts` | One mount line, **before** the global JSON parser. |

**The raw-body problem, and why the mount order is load-bearing.** HMAC is computed over the
exact bytes Intuit sent. `server.ts` currently installs a 50 MB `express.json()` with a custom
`type` predicate and keeps no raw copy, so by the time a controller runs the bytes are gone.

Mount the webhook router **before** that parser, with its own body parser:

```ts
app.use("/api/v1/webhooks", express.raw({ type: "*/*", limit: "5mb" }), webhookRoute);
```

`type: "*/*"` is deliberate. Collections' first live deliveries were **rejected** because its
raw-body middleware only matched `application/json`, and CloudEvents can arrive as
`application/cloudevents-batch+json`. Matching everything on a path that only ever receives
webhooks costs nothing and removes the entire class of failure. Parse the JSON yourself after the
signature passes.

Adding a `verify` callback to the global parser instead would put a raw-body copy on every
50 MB image upload in the app. Don't.

**Handler contract — the ordering is not negotiable**

1. No body bytes, but `content-length > 0` ⇒ **503**. We failed to capture, not their fault.
2. No body bytes and `content-length` 0 ⇒ **200**. Endpoint validation probe. A 4xx here can fail
   Intuit's own verification and disable the subscription.
3. Verifier token unloadable ⇒ **503**, before the signature is even considered. Never 401 —
   telling Intuit our credentials are wrong is the response most likely to get a subscription
   disabled rather than retried.
4. `HMAC-SHA256(rawBody, token)` vs the `intuit-signature` header, for **each** configured token
   (§0.1), `timingSafeEqual` with a length guard, accepting **base64 or hex** (which Intuit sends
   is undocumented; accepting both weakens neither branch). No token matches ⇒ **401, no writes at
   all.**
5. Parse. Unrecognisable shape (including the retired legacy envelope) ⇒ log, **200**.
6. Phase 1: log each event. Phase 2 replaces this step.

**The controller must do its own logging, and it has to be deliberate.** `server.ts`'s
request-logging middleware sits *after* `express.json()`, so a router mounted before that parser
answers and returns without ever reaching it — no method, URL, status, content-type or user-agent
line. Phase 1's entire deliverable is what these logs say, so log, per delivery: the
`content-type` Intuit actually sent; **which signature encoding matched, base64 or hex** (this
settles the open unknown in collections' design §12); **which token matched**, i.e. which keyset
sent it (nothing in the CloudEvent says); and per event the raw `type` string,
`intuitaccountid`, `intuitentityid` and `time`. Log the whole raw array at `info` while Phase 1 is
the only thing shipped — it is a pointer with an empty `data`, so there is no customer data in it
to worry about.

**Status semantics, stated once and held to everywhere.** **200** for anything wrong with *their*
data — unknown realm, unsubscribed entity, duplicate event. All tenants share one endpoint, so a
5xx for one tenant's junk risks the subscription for everyone. **503** only for *our*
infrastructure failing, where Intuit's retry is the only recovery. "Always 200" is too blunt and
costs an event-loss path.

**Token source: env, not the Secrets Manager SDK.** Collections reads Secrets Manager at runtime;
this repo's convention is env-vars-populated-from-a-secret by the task definition, and every other
QBO key already works that way. `QBO_WEBHOOK_VERIFIER_TOKEN_SANDBOX` and
`QBO_WEBHOOK_VERIFIER_TOKEN_PRODUCTION` (§0.1), collected into a `{name, token}[]` at module load
so the verify loop and its log line are the same code whether one or both are set. Neither
present ⇒ 503. One fewer SDK dependency, one fewer IAM grant.

**Test.** `scripts/check-qbo-webhook.ts`, following the repo's standalone-assertion convention
(there is no test runner). It must stay **pure — no DB, no network** — because `npm test` runs
inside the Docker build and a check script that needs a database fails the deploy. Assert: a
known-good body + token verifies; a tampered body does not; a hex signature and a base64
signature both verify; an empty/absent header fails closed; the array parses to entity+operation;
the legacy envelope yields zero events rather than throwing; and — for §0.1 — that with **two**
tokens configured, a body signed with *either* verifies (and reports the right keyset name) while
one signed with a third does not.

**Deploying Phase 1 is a production deploy** — merging to `main` runs CodeBuild straight through
to `techcopilot-prod-assistant`. It adds one unauthenticated route that logs and returns 200.

---

## 3. Phase 2 — the ledger, and processing

### 3.1 One table, `app_user`-owned

```sql
CREATE TABLE IF NOT EXISTS public.qbo_webhook_events (
  id           bigserial PRIMARY KEY,
  event_id     text        NOT NULL UNIQUE,  -- CloudEvents `id`; THE dedup key
  realm_id     text        NOT NULL,
  entity       text        NOT NULL,
  operation    text        NOT NULL,
  entity_id    text,
  event_time   timestamptz,
  raw          jsonb       NOT NULL,
  status       text        NOT NULL DEFAULT 'queued',  -- queued|running|done|skipped|failed
  attempts     integer     NOT NULL DEFAULT 0,
  last_error   text,
  claimed_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  updated_at   timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS qbo_webhook_events_drain_idx
  ON public.qbo_webhook_events (status, created_at) WHERE status IN ('queued','running');
```

`schema.prisma` gains the matching `model QboWebhookEvent`, and the two are checked against
each other with `prisma migrate diff --from-empty --to-schema-datamodel` before the SQL is run.
That is the same check the Phase 1 migration used; its log credits it with catching all 54 of
*that* migration's columns and 8 of its index names. **Phase 6's own numbers are 18 columns and
4 indexes**, which is what `phase6.sql`'s assertion block enforces. It is also what
gives the rule below something to sequence against: without a model there is no image change.

Two obligations from the runbook, both non-negotiable here:

- **The DDL runs BEFORE the image that uses it.** Prisma `SELECT`s every scalar column it knows
  about, so the moment the new client deploys it asks for these columns on every read.
- **There is no migration ledger. Merged ≠ applied.** Probe `information_schema.columns` before
  assuming, and verify afterwards **as `app_user`**, not as the migration role.

This needs the **RDS master credentials**, like every migration here. An earlier draft claimed a
new table could be created as `app_user` and skip them; running it returned `permission denied for
schema public` on the first statement. `app_user` holds no CREATE on `public` at all.

### 3.2 Realm → company: fan out, do not constrain

Collections' §5.1 blocker was that `realmid` had no unique constraint, so a webhook could refresh
invoices inside an abandoned zero-user tenant and the dialer would call people on its behalf. It
fixed that with a partial unique index that deactivated the losing rows.

**Do not port that here, and the reason is the blast radius, not the schema.** `QboConnection`
has the same shape — `companyId` unique, `realmId` nullable and unconstrained — but the
consequence of two companies sharing a realm is one extra QBO read and a second mirror getting
correctly refreshed. Nothing dials anybody. And the sandbox realm we test against very likely
*is* attached to more than one company row already; a unique index would fail to build or would
silently deactivate a connection someone is using.

So: resolve **every** `QboConnection` whose `realmId` matches **and** for which
`qboConnected(conn)` holds, and refresh each with its own token. That predicate already excludes
rows minted under the other keyset, which is precisely the "abandoned tenant" case in this repo.
Zero matches ⇒ log, mark `skipped`, **200**.

*Worth probing while Phase 2 is being built:* `select realm_id, count(*) from qbo_connections
group by 1 having count(*) > 1`. If it comes back empty in production, the fan-out costs nothing
and is still the right shape for when it does not.

### 3.3 Processing: table-as-queue, drained in process

Collections uses SQS with a dedicated worker container. **Do not copy that.** copilot-server has
no queue, no worker, no cron and no Terraform — it is one ECS service running one task. SQS here
would mean a new queue, a new container, new IAM and a new deploy path, to move work that a table
already tracks.

The drain is a small in-process loop (a 5-second `setInterval`, started from `server.ts`,
`.unref()`'d). It claims work with a **conditional `updateMany` gated on the row count**, which is
the pattern `syncQboReferenceData` already uses for `sync_started_at` — and it was chosen there
for a reason worth repeating: `pg_try_advisory_lock` is **re-entrant**, so two runs sharing a
pooled connection both "acquire" it, the first unlock frees it for both, and the guard reads as
working while preventing nothing. A conditional update returning a count has no such ambiguity,
and it stays correct if the service ever scales past one task.

Retries: bump `attempts`, mark `failed` past a small cap. No exponential-backoff arithmetic —
Intuit's own redelivery covers the window that matters, and a stuck row is visible in the table,
which is the question a DLQ cannot answer anyway.

### 3.4 The fork worth deciding — how a refresh is done

**MVP: debounce and re-run the existing stage.** Coalesce events per `(company, entity)` over
~10 seconds, then call the ingest stage that already exists — `ingestCustomers`,
`ingestItems`, `ingestAccounts`, `ingestTaxPrefs`. Ten customers touched in a bulk edit become
one refresh, not ten.

It reuses code that is tested against real data and has subtleties a per-id path would have to
re-earn: pass-2 parent linking, the unambiguous-name adoption rule, the disambiguating-suffix
heal, T-46 deactivation. On the sandbox realm a full customer pull is 39 rows in one query.

**`customer.merge` is the argument that settles it.** Now that all operations are subscribed, merge
events will arrive. Collections faced this and **refused to handle it** — it marks the job `failed`
and leaves it for a manual sync, because the surviving id is not reliably knowable from the event,
and picking the wrong survivor re-points invoices at the wrong customer. A fetch-by-id handler here
would inherit that same dead end: `intuitentityid` on a merge is a customer that may no longer
exist.

The full re-pull has no such problem. It reads current state, and `ingestCustomers`' T-46 sweep
deactivates every customer QuickBooks no longer returns — which is exactly what a merged-away
customer is. The MVP handles a case the "better" design cannot, for free, and the same holds for
`item.merge` and any delete.

Two guards make that safe, and both already exist: the sweeps run **only on a complete pass**
(`ingestSalesTax` skips its sweep if any code was skipped; `queryAll` throws
`QboIncompleteReadError` rather than returning a short read that would look like mass deletion),
so a truncated read can never mass-deactivate a live list.

The cost is honest: on a large production realm, one renamed customer pulls the whole list. That
is the trigger for v2, not a reason to skip the MVP.

**v2: fetch by id.** `intuitentityid` is right there. This means extracting the per-row upsert out
of each ingest loop so both the full sync and the webhook call the same function — a genuine
refactor of `qboIngest.ts`, and the ingest loops are where all the hard-won correctness lives.

**Recommendation: MVP now, v2 when a real customer's realm makes the full pull expensive.** The
`syncQboReferenceData` row claim must be respected either way, or a webhook burst and an admin's
Sync click race the same upserts *and* the unserialised token refresh — the failure T-44 exists to
prevent. A webhook that cannot claim should re-queue, not skip: a sync running right now will
finish, but it may have started before the change.

### 3.5 Handler table (Phase 2 scope)

| Entity | Operation | Action |
|---|---|---|
| `customer` | any | Debounced `ingestCustomers`. |
| `item` | any | Debounced `ingestItems`. |
| `account` | any | Debounced `ingestAccounts`. |
| `taxagency` | any | Debounced — re-runs the **`salesTax` stage** (`ingestSalesTax` reads TaxCode + TaxRate; TaxAgency itself is never read) **and `ingestTaxPrefs`**, per §0.2. |
| `estimate` | any | Phase 3. Until then: recorded, `skipped`, and **the log line is the deliverable** — it is how we learn the operation vocabulary. |
| anything else | any | Log, `skipped`, 200. |

Every operation is subscribed, so `delete`, `merge`, `void` and `emailed` all land in the "any"
rows above and go through the same refetch. `estimate.emailed` is worth watching in Phase 1's logs
— it may be the cheapest signal that a customer has actually been sent the estimate.

Two rules copied from collections verbatim, because both were paid for:

- **Unknown operation on a known entity ⇒ refetch.** Never hardcode an operation enum against a
  vocabulary nobody can enumerate. Re-reading current state is always safe.
- **Entity already gone at fetch time ⇒ `skipped`, not `failed`.** A create-then-delete, or the
  refetch default landing on a deleted record. Retrying cannot conjure a deleted row, and letting
  these pile into `failed` poisons the count we want to read as "this tenant needs reconnecting".

---

## 4. Phase 3 — Estimate semantics (T-29 / gap #10)

No estimate ingest exists today; this is the new behaviour, and it is the reason the feature is
worth building.

- **`estimate.updated`** → fetch by `intuitentityid`, match `Quote.qboEstimateId`. Store QBO's
  `SyncToken` and the estimate's status/`TotalAmt`. Re-completion can then **detect** that
  somebody edited the estimate inside QuickBooks instead of silently overwriting it — which is
  what the update-in-place path does now.
- **`estimate.deleted`** → clear or flag `qboEstimateId`. This also closes **gap #9**: today
  disconnecting or deleting leaves every completed quote showing "In QuickBooks as estimate
  &lt;id&gt;", pointing into a file that no longer holds it.
- **Accepted / converted** → written once Phase 1's logs say what Intuit actually emits. If the
  estimate fires nothing on acceptance, the fallback is subscribing to **Invoice** and matching
  `LinkedTxn[].TxnType === "Estimate"`.

**Blocking dependency, flagged early:** this needs new columns on `quotes`, and `quotes` /
`quote_line_items` are owned by **`postgres`, not `app_user`** — so the DDL needs RDS master
credentials and **Bharath has to run it**, the same way Phase 1b and Phase 2 went. Everything in
Phase 2 avoids that deliberately; Phase 3 cannot.

---

## 5. Phase 4 — frontend (`technician-copilot`), batched

Small, and held back until phases 2–3 are real. Merging `main` deploys straight to production via
Amplify, so this ships as **one reviewed batch**, not per-change.

- **`ConnectionsCard`** — the status line today reads only "last synced". Add "live — last change
  received &lt;time&gt;", so an admin can tell webhooks from a stale manual sync. Existing
  `GET /connections` response gains a field; no new endpoint.
- **`QuoteDetail`** — a "changed in QuickBooks" indicator on a quote whose stored `SyncToken` no
  longer matches, and the "In QuickBooks as estimate &lt;id&gt;" badge stops lying once Phase 3
  clears deleted ids.
- Frontend typecheck is `npm run typecheck` (`tsc -b` with two known `src/lib/api.ts` errors
  filtered) — **`tsc --noEmit` compiles nothing here**, `tsconfig.json` has `"files": []`.

---

## 5.5 Built — 2026-09-09

Phases 1 and 2 are implemented, plus the half of Phase 3 that needs no DDL. `npm test` is green
(18/18 plus every check script), and the receiver was smoke-tested over real HTTP.

| File | What |
|---|---|
| `src/lib/qboWebhook.ts` | **New.** Pure: the two-keyset token set, HMAC verify returning *which* keyset matched, CloudEvents parse, `STAGE_FOR_ENTITY`. |
| `src/api/controllers/webhook.controller.ts` | **New.** The receiver, with the status contract of §2. |
| `src/api/routes/webhook.route.ts` | **New.** `POST /qbo`. |
| `src/lib/qboWebhookProcessor.ts` | **New.** Record + drain: stale reclaim, token claim, realm fan-out, stage coalescing, estimate handling, retry/requeue. |
| `scripts/check-qbo-webhook.ts` | **New.** 40-odd assertions, pure. Wired into `npm test`. |
| `docs/sql/phase6.sql` + `apply-phase6.sh` | **New.** The ledger DDL and its runner. |
| `prisma/schema.prisma` | `model QboWebhookEvent` (+54 lines, purely additive). |
| `src/lib/qboIngest.ts` | `syncQboReferenceData` now delegates to an exported `runQboSync(companyId, stages, {markComplete})`. Existing behaviour unchanged. |
| `src/server.ts` | The mount, before `express.json()`, and the drain start. |
| `package.json`, `.env.example` | The check script; the two token key names. |

**Verified over real HTTP**, not just in unit assertions — an Express app with the same mount
order, driven with real signed requests:

- raw bytes captured for `application/json`, **`application/cloudevents-batch+json`** and
  `text/plain` — the `*/*` matcher is doing its job, and this is the exact failure that rejected
  collections' first live deliveries;
- **both** keysets verify, in **both** base64 and hex;
- unsigned, mis-signed and foreign-token bodies all 401 with no write;
- an empty-body probe answers 200 (endpoint validation cannot be failed);
- the retired legacy envelope answers 200, not a crash;
- with no database reachable, a valid delivery answers **503** — fail-closed on our own
  infrastructure, which is what asks Intuit to redeliver.

**Two design points worth recording, because neither was in the original plan.**

`runQboSync` takes `markComplete`, and webhooks pass `false`. `lastSyncAt` means "last COMPLETE
sync" (T-45); a partial webhook refresh of one mirror must not advance it, or the Connections card
claims a freshness the other mirrors cannot back. For the same reason a webhook failure does not
write `lastSyncError` — those two fields describe the manual sync, and a webhook's outcome belongs
on its own ledger row.

A busy sync **re-queues, never skips.** `QboSyncBusyError` is its own class so the drain can tell
"someone holds the claim" from "this failed". The running sync will finish, but it may have
started before the change that triggered us, so dropping the event would lose the update. Attempts
are not bumped: waiting for a lock is not a failure.

**One bug the review caught, worth recording because the fan-out design causes it.** A realm
connected to two companies processes each of its events twice, once per company. Settling inside
that loop let the second write overwrite the first: company A succeeding and company B failing put
the row back to `queued`, so the next pass re-synced A for nothing — and the counts were doubled.
Outcomes are now collected and each row settled **exactly once**, with retry beating `done`
beating `skipped`: the row must come back if any company still owes work on it. This only bites on
multi-company realms, which is precisely the case §3.2 chose to support instead of constraining.

**The drain does not start without `DATABASE_URL`.** A local `npm run dev` would otherwise log a
Prisma error every ten seconds, drowning whatever the developer is working on. Deployed
environments always have it.

**Phase 3, the half that needed no DDL, is done.** `estimate.deleted` clears `qbo_estimate_id` and
`qbo_synced_at` on matching quotes — closing gap #9's lying badge with columns that already exist.
Drift detection (a stored `SyncToken`, so re-completion can tell an edit made inside QuickBooks
from one of ours) still needs a column on `quotes`, which is `postgres`-owned. Until then a
non-delete estimate event is recorded and `skipped`, **and its `operation` in the ledger is the
deliverable** — it is how we learn Intuit's real vocabulary for this entity.

`select operation, count(*) from qbo_webhook_events where entity = 'estimate' group by 1;`

**Not built: Phase 4 (frontend).** Untouched on purpose — `technician-copilot` has UI work in
flight in another session.

---

## 5.6 Applied to production — 2026-09-09

**Recorded here because there is no migration ledger. Merged is not applied, and applied is not
merged; right now this feature is the second of those.**

| Step | State |
|---|---|
| `docs/sql/phase6.sql` | **APPLIED.** 6/6 statements, `PHASE6_APPLIED`, exit 0. Credentialed revision `:109` deregistered on exit. |
| Verified as `app_user` | **PASS.** A real insert -> select -> delete round-trip on `qbo_webhook_events` from the service's own task definition: `user=app_user owner=postgres indexes=4 read_back=skipped ledger_rows=0`. The sentinel row cleaned itself up. |
| `qbo_connections_realm_id_idx` | Created (statement 5/6). |
| Verifier tokens | **LIVE.** `techcopilot/prod/app` 30 -> 32 keys, version `1aa68225-d237-48f2-9bda-ceb4a96d5e11`. Task definition `:110` registered (25 -> 27 container secrets) and the service moved onto it; rollout COMPLETED, 1/1, single deployment. |
| Code | **NOT deployed.** `/health` answers 200 with the pre-webhook shape and `POST /api/v1/webhooks/qbo` returns **404**, because the running image is `723f969` from `main`. Both are the correct pre-merge answers. |

### The premise that was wrong, and how it failed

The first attempt ran on the service's own task definition, because this migration only CREATEs
its own new table and therefore -- so the reasoning went -- needed no master credentials. It failed
on the very first statement:

```
[1/6] FAILED: CREATE TABLE IF NOT EXISTS "public"."qbo_webhook_events" (
Raw query failed. Code: `42501`. Message: `ERROR: permission denied for schema public`
```

**`app_user` holds no CREATE on schema `public` at all.** Creating a table is not a lesser
privilege than altering one, and there is no "new table" exemption to find. Every apply script in
`docs/sql/` takes the master credentials; this one now does too.

Worth recording rather than quietly fixing: that claim was written confidently, survived a
nine-reviewer review, and was disproved by the first statement that ran. Nothing local could have
caught it -- `bash -n` passed, the generated runner was valid JavaScript, and the data-migration
reviewer independently confirmed the SQL matched Prisma exactly. Only production had the answer.

### Renumbered 4 -> 6

Phases **5 and 5b** (the company-level "Enable tax" switch) landed on `main` and were applied
while this work was in review, so `docs/sql/` now runs 1b, 2, 3, 5, 5b. A migration numbered 4
would sit *below* an already-applied one and read as "should have run first", which is the one
thing a sequence number exists to say. `phase4.sql` -> `phase6.sql`, `apply-phase4.sh` ->
`apply-phase6.sh`.

---

## 6. Order of operations

| # | Step | Who | Blocks |
|---|---|---|---|
| 0 | ~~Register URL + streams on both keysets, CloudEvents format~~ | Bharath | **done 2026-09-09** |
| 1 | ~~`bash scripts/set-qbo-webhook-env.sh --apply`~~ | **DONE 2026-09-09 — secret v`1aa68225`, task def `:110` live** | — |
| 2 | ~~Build the receiver, the ledger and the drain~~ | **done 2026-09-09 — see §5.5, `npm test` green** | — |
| 2a | ~~`bash docs/sql/apply-phase6.sh`~~ | **DONE 2026-09-09 — see §5.6** | — |
| 2b | Review, then merge to `main` — which deploys prod | Bharath | 2a |
| 3 | Confirm one real delivery verifies (a mis-pasted token 401s everything) | both | 1, 2 |
| 4 | Watch a day of real sandbox deliveries; record the operation vocabulary — especially `estimate.*` and `estimate.emailed` — back into §3.5 | me | 3 |
| 5 | ~~Model, diff, DDL, processing~~ | **done — folded into step 2** | — |
| 6 | Phase 3's remaining half: a `SyncToken` column on `quotes` (**master creds — Bharath**), then drift detection. `estimate.deleted` already ships in step 2. | both | 4 |
| 7 | Phase 4 frontend, one batch — **not started**, `technician-copilot` has UI work in flight elsewhere | — | 6 |
| 8 | At the production flip: nothing to re-register — the URL is already on both keysets and both tokens are already loaded. Companies still reconnect (the `environment` stamp), and production events start resolving to real connections. | — | — |

Steps 1 and 2 are independent and can run in either order: without the tokens the receiver answers
503 and Intuit redelivers; without the receiver the tokens sit unused.

**Working-tree state, 2026-09-09.** Both repos fetched and level with `origin/main`
(`5632c1a` / `39876fc`). copilot-server carries, from this session: a modified `.env.example`
(the two key names, no values), untracked `docs/qbo/QBO-WEBHOOKS-PLAN.md` and untracked
`scripts/set-qbo-webhook-env.sh`. Those three are the webhook commit; nothing else should ride
with it.

The tree churned while the plan was being written — `QBO-INTEGRATION.md`'s uncommitted edits were
reverted, `quote.controller.ts` appeared modified and then reverted, and the untracked
`QBO-ARCHITECTURE.md` was deleted. The only stash (`stash@{0}`) is unrelated August estimate work.
Assume someone else is in this repo and re-check `git status` before committing.
