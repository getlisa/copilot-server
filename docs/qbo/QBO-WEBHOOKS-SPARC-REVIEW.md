# QuickBooks webhooks — SPARC review

> **POINT-IN-TIME REVIEW, 2026-09-09.** Line numbers and figures are as of that day and are
> deliberately NOT updated — this is the record of what the review found, not a live document.
>
> **State at review time:** `copilot-server` PR #17 open, not merged, branch `feat/qbo-webhooks`
> at `bfc5bbe`, base `main` at `5632c1a`. 14 files, +1867/-26, 972 executable changed lines.
> `docs/sql/phase4.sql` is **not applied anywhere** — `qbo_webhook_events` does not exist in
> production, so no row needed repairing for any finding below. The verifier tokens are **not** in
> `techcopilot/prod/app`; the service runs task definition `:105`, built from `5632c1a`, which has
> no `/api/v1/webhooks` route. Measured the same day: the endpoint 404s in production.
>
> **Method:** nine specialist reviewers over one diff — correctness, security, adversarial,
> reliability, data-migration, api-contract, performance, testing, maintainability. Standards lens
> skipped, with disclosure: no `CLAUDE.md` or `AGENTS.md` governs any path in this repo. The
> cross-model adversarial pass could not run — no second-provider CLI on this host — so
> adversarial ran in-process, and its findings carry the same-model blind spot that implies.

## Disposition summary

| | count |
|---|---|
| P1 | 7, **all fixed** (1 of them blocked the deploy outright) |
| P2 | 13, **all fixed** |
| P3 | 8, **all fixed** |

**All 28 findings were fixed in the same branch on 2026-09-09**, after the review. Verification
below each. Three carried residual risks remain open by decision, and are listed at the end.

**F1 is the finding worth remembering.** The reasoning that produced it was *correct* — phase 4
creates a new table, so it needs no master credentials, and the apply script deliberately omits
them. The defect is that it then reused a helper whose entire premise is that master credentials
are being swapped in. A right conclusion, wired to the wrong mechanism.

**F2, F3 and F4 all live in six lines that exist only because of the previous review round.** The
`record`/`RANK` precedence block was written to fix a fan-out double-settle that an earlier review
caught. That fix introduced three new defects. Worth stating plainly, as this repo's Phase-1 SPARC
review already recorded once: **a review pass is not a safe operation.**

**Every one of the nine reviewers independently flagged the same coverage gap** —
`src/lib/qboWebhookProcessor.ts` has zero automated coverage. That unanimity is itself the
finding: six of the seven P1s live in the one file no test touches.

---

## F1 (P1) — the migration script connects as user `"undefined"`. FIXED

`docs/sql/apply-phase4.sh` runs the runner built by `docs/sql/build-runner.py`, whose template
does this unconditionally (`build-runner.py:61-67`):

```js
u.username = encodeURIComponent(process.env.PGMASTER_USER);
u.password = encodeURIComponent(process.env.PGMASTER_PASSWORD);
console.log('connecting as', process.env.PGMASTER_USER, 'to', u.host + u.pathname);
```

Phases 1b, 2 and 3 register a throwaway task definition carrying the RDS master secret, so those
variables are set. **Phase 4 deliberately does not** — it creates a new `app_user`-owned table and
correctly needs no master credentials, so it runs on the service's own task definition.

`encodeURIComponent(undefined)` returns the **string** `"undefined"`. So the runner would connect
as user `"undefined"`, password `"undefined"`, fail authentication, and print `connecting as
undefined`. **The ledger DDL never applies**, and step 1 of the documented merge order cannot
succeed.

Not caught by anything: `bash -n` passes, `build-runner.py` produces valid JavaScript, and the
generated runner was checked with `node --check`. Only running it against the VPC would have
surfaced it, which is exactly what the script exists to do.

**Fixed:** the swap in `build-runner.py` is guarded on both variables being present. Verified by
executing the generated runner both ways — without them it keeps the app's URL and logs
`connecting as the app user`; with them (the phases 1b/2/3 path) it still swaps to `postgres`.

## F2 (P1) — an equal-rank outcome discards the attempts bump and the error. FIXED

Found independently by **reliability, correctness and adversarial**.

`src/lib/qboWebhookProcessor.ts:174`:

```ts
if (prev && RANK[prev.status] >= RANK[status]) return;
```

`RANK.queued` is 3. A `QboSyncBusyError` requeue records `record(id, "queued")` with **no**
attempts and **no** error. A genuine stage failure records `record(id, "queued", message,
attempts)`. When the busy one is recorded first, `3 >= 3` returns early and the failure's
`attempts` and `lastError` are **silently discarded**.

At settle the column is omitted when `attempts === undefined`, so the counter never advances,
`MAX_ATTEMPTS` is never reached, and the row retries **every 10 seconds indefinitely** with no
`last_error` to diagnose it. Ordering between two companies on one realm is arbitrary.

**Fixed:** the precedence moved into `mergeOutcome` in the pure module, where diagnostics merge
*independently* of which status wins — attempts take the max, the first error is kept. Pinned by
assertions that fail against the old code, in both orderings.

## F3 (P1) — `queued` outranks `done`, so a broken sibling re-runs a healthy tenant's sync. FIXED

Found independently by **adversarial and security**. Same `RANK` table, different failure.

Company A succeeds (`done`, rank 1). Company B on the same realm has a broken connection and
requeues (`queued`, rank 3). `queued` wins, the row returns to the queue, and **A's full mirror
re-pull repeats on every pass** — forever, because B is permanently broken. The fan-out design
implies a per-(row, company) outcome; the schema stored one status per row.

**Fixed:** `done_companies int[]` now records which companies finished a row, and the drain skips
them on later passes. The row still returns for the company that is genuinely owed work, which is
the correct behaviour; what stops is redoing the company that already succeeded.

## F4 (P1) — the settle ignores the claim token it documents. FIXED

Found independently by **correctness and adversarial**. `:252-254` settles with
`update({ where: { id } })` — no `claimToken` predicate — directly contradicting the function's
own contract at `:119-120`:

> *Safe to call concurrently: rows are claimed with a token, and a pass only ever touches rows
> carrying its own.*

Latent today (one ECS task plus the in-process `running` guard), but it is precisely the invariant
the `QboWebhookEvent` model comment claims already holds "if the service ever scales past one
task". The claim gets this right; the settle did not.

**Fixed:** `settleOutcomes` writes with `updateMany({ where: { id: { in: ids }, claimToken } })`
and warns when the affected count is short — which also folded in F15, since rows sharing a
payload now settle in one statement instead of 200.

## F5 (P1) — a stage-name typo is a silent no-op. FIXED

`src/lib/qboWebhook.ts:192` types the map as `Record<QboEntity, string | null>` — plain `string` —
and the processor launders it through `as QboSyncStage[]` at `:213` and `:220`. Writing
`"customer"` for `"customers"` compiles, passes the cast, never matches `wanted()` inside
`runQboSync`, and the customer mirror silently stops refreshing. No error anywhere.

**Fixed:** `STAGE_FOR_ENTITY` is now `Record<QboEntity, QboSyncStage | null>` via a type-only
import, erased at compile time so the pure module still imports nothing but `crypto` at runtime.
The two `as QboSyncStage[]` casts that laundered the old type are gone. `tsc` rejected the old
call sites the moment the type landed, which is the proof.

## F6 (P1) — a terminal failure is unrecoverable, and redelivery cannot revive it. FIXED

`MAX_ATTEMPTS = 5` with **no backoff**: five passes at 10s is ~50 seconds, shorter than a
QuickBooks throttle window. Once `failed`, nothing re-queues the row — and the design doc's claim
that Intuit's redelivery is the recovery path is **false here**, because
`createMany({ skipDuplicates: true })` on the unique `event_id` means a redelivery inserts nothing
and the dead row stays dead. A brief QBO outage therefore loses events permanently.

**Fixed:** two changes. `next_attempt_at` carries exponential backoff (30s → 2m → 8m → 32m,
capped at 2h), so the five attempts span **42.5 minutes** rather than ~50 seconds; and
`recordQboWebhookEvents` now revives `failed` rows on redelivery, so Intuit's retry is genuinely
the recovery path the design claims. The backoff span is asserted.

## F7 (P1) — the drain is untestable only by assertion, not in fact. FIXED

Flagged by **all nine reviewers**. The PR and the plan both claim the drain cannot be unit-tested
because `npm test` runs inside the Docker build with no database. `src/lib/prisma.ts:39-41`
disproves it — the client is already built to construct safely with no `DATABASE_URL`, and its own
comment says *"the Docker build running checks"*. The `RANK` precedence and the stage-coalescing
logic are pure computations that can be extracted and pinned under the existing convention.

Six of the seven P1s above live in that untested file.

**Fixed:** the decision logic — outcome precedence, stage coalescing, backoff, the unparseable
dedup key — moved into `qboWebhook.ts` as `mergeOutcome`, `stagesForEntities`, `backoffMs` and
`unparseableEventId`, and `scripts/check-qbo-webhook.ts` now pins all of it. The processor keeps
only the database choreography.

---

## P2 findings

| # | Finding | Where | Reviewers |
|---|---|---|---|
| F8 | The admin **Sync** button answers `502 "Could not read from QuickBooks"` when the drain holds the claim — a false message, newly reachable because the drain competes every 10s instead of only on a human click. The endpoint already uses 409 for its other not-ready state. | `company.controller.ts:318` | correctness |
| F9 | `keyset` is written to every row and **never read**. `companiesForRealm` filters only on `qboConnected`, which compares against the server's `QBO_ENVIRONMENT`, not the delivery's keyset. | `qboWebhookProcessor.ts:81` | security |
| F10 | Head-of-line starvation: requeued rows keep `createdAt`, so ≥200 requeuing rows from one tenant occupy every pass — contradicting the `BATCH_SIZE` comment's claim to bound exactly that. | `:139` | adversarial, correctness |
| F11 | No retention or pruning. Every raw CloudEvent is kept forever; nothing deletes. | `phase4.sql:29` | data-migration, adversarial |
| F12 | A claimed row that no branch handles is never settled and strands in `running` until the 10-minute reclaim, forever. Closed today only because null-entity rows insert as `skipped`. | `:215` | adversarial, correctness |
| F13 | An unparseable delivery is logged and discarded with **no row**, so the feed can go dark with nothing in the table to show it. | `webhook.controller.ts:99` | adversarial |
| F14 | An oversized or truncated body reaches the app-wide handler, which returns **500 unconditionally** — not the 503 the status contract documents. Still a 5xx, so Intuit retries; the code is wrong, the behaviour is survivable. | `server.ts:156` | api-contract, security |
| F15 | The settle loop issues one `UPDATE` per row, up to `BATCH_SIZE` 200, sequentially. | `:253` | performance |
| F16 | `companiesForRealm` is an N+1 per distinct realm against **`qbo_connections.realm_id`, which has no index** — confirmed, the table carries only `qbo_connections_company_id_key`. | `:181` | performance |
| F17 | The mount-order guard **false-passes if the mount is commented out** — `indexOf` finds the text inside a comment. A silent-pass guard against a silent break. | `check-qbo-webhook.ts:167` | testing |
| F18 | `markComplete` defaults to `true` even with a partial `stages` list; nothing enforces the pairing that T-45's invariant depends on. | `qboIngest.ts:688` | api-contract, maintainability |
| F19 | The retry/attempts classification is duplicated verbatim in two catch blocks, and `drainQboWebhookEvents` mixes claim, routing, dispatch and settlement in one function. | `:122`, `:234` | maintainability |
| F20 | Five parallel `if (wanted(x))` blocks instead of a stage-runner table — a future stage added to the union without a runner is a silent no-op, not a compile error. | `qboIngest.ts:734` | maintainability |

## P3 findings

| # | Finding | Where |
|---|---|---|
| F21 | The "Pull every reference entity" docstring is **orphaned** — it now sits between `ingestAccounts`'s closing brace and a constant, documenting nothing. | `qboIngest.ts:635` |
| F22 | The index assertion uses `IF idx < 4` where the column check uses `<> 16` and the message claims an exact count; it cannot catch extra or drifted indexes. | `phase4.sql:90` |
| F23 | The plan's "54 columns and 8 index names" reads as a claim about this table. It is a citation of what the *Phase 1* log credits the same check for. Correct as written, **ambiguous as read** — reword, do not renumber. | `QBO-WEBHOOKS-PLAN.md:301` |
| F24 | 401 rejections on an unauthenticated public route log no source address. | `webhook.controller.ts:70` |
| F25 | `set-qbo-webhook-env.sh` leaves the full cleartext production secret bundle on disk through the multi-minute `services-stable` wait. | `:56` |
| F26 | Response bodies use a bare shape while every other controller uses `{success, error:{status,message}}`. Intuit reads only status codes, so this is internal inconsistency. | `webhook.controller.ts:75` |
| F27 | No liveness signal distinguishes a stalled drain from an idle one. | `server.ts:104` |
| F28 | The raw parser is scoped to the `/api/v1/webhooks` **prefix**, so a future sibling route would silently receive a `Buffer` instead of parsed JSON. | `server.ts:48` |

## Carried residual risks

- **Prisma `createMany` is not chunked.** A verified delivery above roughly 5,400 CloudEvents
  exceeds Postgres' 65535 bind-parameter limit, throws, and returns 503 — which Intuit redelivers,
  producing a permanent loop on the same oversized body. Reachable only by a token holder, and
  Intuit's real batch sizes are small, so this stayed a risk rather than a finding.
- **No rate limiting anywhere in the app.** Pre-existing, but this is the first route whose
  expected caller is an unauthenticated stranger. `express.raw` also defaults to `inflate: true`,
  so gzip decompression happens before the signature check — bounded by the 5 MB limit.
- **`handleEstimateEvent` matches quotes on `qboEstimateId` alone.** QuickBooks estimate ids are
  small per-realm integers, so a company that reconnected to a different realm could have a quote
  cleared by an unrelated delete. Not fixable without a realm column on `quotes`, which is
  `postgres`-owned and blocked on master credentials.
- **Realm fan-out spends one realm's pooled API quota twice.** The blast-radius argument against a
  deactivating unique index still holds; the probe
  `select realm_id, count(*) from qbo_connections group by 1 having count(*) > 1` was never run,
  so whether fan-out is live or dormant today is unknown — and that determines whether F3 and F9
  are live or latent.

## Withdrawn

- Adversarial claimed the check script "never verifies" mount order. It does
  (`assert.ok(rawMount < jsonParser, …)`). The testing reviewer's narrower criticism — that the
  assertion exists but false-passes on a commented-out mount (F17) — is the accurate one.
- Data-migration proposed correcting the plan's "54 columns / 8 indexes" to "16 / 4". That would
  make the sentence false about Phase 1; reclassified as F23, an ambiguity to reword.
- Reliability's brief premise that the QuickBooks calls have no timeout does not hold:
  `src/lib/qbo.ts` already applies `AbortSignal.timeout(30s)` plus three backed-off retries,
  pre-existing under T-43 and untouched here.

## Verdict

**Not ready to merge.** F1 alone blocks the documented deploy order — the ledger DDL cannot apply.
F2/F3/F4 are a cluster in six lines of one function and produce, between them, unbounded 10-second
retry loops that burn a shared QuickBooks API quota with no diagnostic trail. F5 and F6 are silent
failure modes of exactly the kind this feature exists to eliminate.

The receiving half stands up well: no reviewer found a path to a database write before signature
verification, the HMAC comparison itself was checked and cleared, and replay handling is durable.
The defects are concentrated in the drain — the half with no tests.
