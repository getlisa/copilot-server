# QBO ingestion + customers/sales-tax entities — SPARC review

> **POINT-IN-TIME REVIEW, 2026-09-08.** Line numbers and figures are as of that day and are
> deliberately NOT updated — this is the record of what the review found, not a live document.
>
> **State at review time:** `copilot-server` PR #13 and `technician-copilot` PR #7 open, neither
> merged. The entity migration (Phase 1) is **not applied anywhere** — `customers`, `customer_qb`,
> `sales_tax` and `sales_tax_qb` do not exist in production, so no row needed repairing for any
> finding below. Production runs the reference-ingestion build: `raw_*_qb` + `qbo_item_links`
> exist and hold one sandbox sync (39 customers, 43 items, 3 tax rates, 90 accounts).
> Measured the same day: **0 of 99 quotes** carry `qbo_customer_id`, and **0** have been posted
> to QuickBooks.
>
> **Method:** seven specialist reviewers over both diffs — correctness, security/multi-tenancy,
> data-migration, API contract, reliability, adversarial, testing. Standards lens skipped, with
> disclosure: no repo-level `CLAUDE.md` governs these paths.

## Disposition summary

| | count |
|---|---|
| P0 | 2, both fixed |
| P1 | 12, of which 8 fixed, 2 need a product decision, 2 deferred with IDs |
| P2 | 14, of which 10 fixed, 4 deferred |
| P3 | 12, of which 6 fixed, 6 deferred |

Three independent reviewers found F1 separately. That is the finding worth remembering: each half
of the source-of-truth rule read correctly on its own, and only the combination was fatal.

**F33 was introduced by the fix for F15 in this same round** — see below. Worth stating plainly:
a review pass is not a safe operation, and the second P0 exists because the first fix was applied
without re-checking the constraint it depended on.

## F1 (P0) — every ingested tax rate was unusable. FIXED

`ingestSalesTax` never wrote `source`, so the column default `MANUAL` stuck. Combined with the
rule that a connected company cannot *use* MANUAL rates, and cannot *create* one either:

- `usable` was false for every synced rate,
- `defaultSalesTax` could only ever return null,
- `upsertSalesTax` refused to create a replacement.

A company that connected QuickBooks and synced would have had **zero usable tax rates and no way
to obtain one**, with the settings card telling them each rate was "created here" — a false
statement. Every estimate would go out untaxed.

Fixed: `source: "QBO"` on both the create and the update branch (a MANUAL rate later adopted by
name genuinely comes from QuickBooks, and leaving it MANUAL keeps it unusable forever). The rule
is now the exported pure predicate `salesTaxUsable`, asserted across all four
(source, connected) combinations plus both veto flags — the first of those assertions goes red on
the old code. No data repair was needed: `sales_tax` does not exist in production yet.

## F2 (P1) — a CRM-connected company is locked out of tax entirely. RESOLVED BY SCOPE

`taxSourceIsExternal` treats any `crm_connections` row as external, so a ServiceTitan company
cannot create a MANUAL rate — but **nothing ingests tax from a CRM**, and the settings card tells
them to "sync your CRM from Connections to import them", pointing at an importer that does not
exist. Any rate created before connecting silently stops applying.

**Decided 2026-09-08: CRMs are out of scope for this work — QuickBooks only.** The CRM branch is
removed from `taxSourceIsExternal`, so a ServiceTitan company keeps its manual rates and is not
locked out of anything. When a CRM tax importer exists, that is when the branch comes back.
T-40 closed.

## F3 (P1) — tax re-sync matched on NAME only. FIXED

A code renamed in QuickBooks created a *second* `sales_tax` row while the original kept its
percentage, its `isActive` and its `isDefault` — so the company quoted a stale rate forever. A
code deleted or deactivated in QuickBooks was simply absent from the loop and survived as the
active default at a rate that no longer existed.

Fixed: match on the TaxCode's QuickBooks id via `sales_tax_qb` first, fall back to name, follow
renames, and deactivate codes that no longer appear — clearing `isDefault` when doing so. The
deactivation sweep runs **only on a complete pass**; a truncated read would otherwise deactivate
live rates.

## F4 (P1) — `crm_connections.provider` coupled us to an un-extendable enum. FIXED

The new `taxSourceIsExternal` selected `provider`, a Postgres enum owned by the platform backend
that this very schema records as un-extendable without breaking our generated client — and the
value was never used. The day that team adds a provider, **every tax endpoint 500s with no change
on our side**. Fixed: `select: { id: true }`; existence is all the function needs.

## F5 (P1) — the customer name fallback could re-point an existing link. FIXED

Rename "Acme" in QuickBooks, create a new "Acme", and the next sync's name fallback landed on the
old CLARA row and **overwrote its `qboId`** — re-pointing every quote that bills that customer at
a different party in the client's books. Where a link already existed for the incoming id, the
same write raised a unique violation and aborted the sync mid-loop.

Fixed: a name match is refused when that customer is already linked to a different QuickBooks
customer in this realm; the incoming id gets a fresh customer, suffixed with its QuickBooks id so
the `(company, name)` unique cannot abort the run. The conflict is logged with both ids.

## F6 (P1) — no backfill; Phase 2 destroyed every quote's customer link. RESOLVED DIFFERENTLY

Phase 1 added `quotes.customer_id` and nothing populated it; Phase 2 dropped `qbo_customer_id`.
The damage was not a blank field: `syncQuoteToQbo` calls `ensureQboCustomer` unconditionally, so a
re-completed quote with a null `customer_id` fell into the legacy free-text branch and re-resolved
the customer from `customerName` — re-pointing the estimate at a different customer, or creating
one **literally named "Customer"** when that field was blank.

**Decided 2026-09-08: no backfill.** Older estimates are not migrated — a company with no
integration has nothing to carry across, and a company with one gets a per-estimate
**"Sync to QuickBooks"** action beside Send / Download, so an old estimate reaches the books when
someone actually wants it there.

A backfill was written and then removed in favour of that. What made the missing backfill
dangerous was never the null column: it was the legacy branch **inventing a customer**. That is
now closed in code — `ensureQboCustomer` refuses a quote with no customer name instead of
creating a QuickBooks customer literally called "Customer" in the client's books, and sends the
technician back to the picker. Measured the same day: 0 of 99 quotes carry a link and 0 have been
posted, so nothing is abandoned.

## F7 (P1) — item and account mirrors are not realm-scoped. DEFERRED → **T-41**

`raw_item_qb` and `raw_account_qb` are keyed on company only, while `qbo_item_links` is
realm-keyed. After reconnecting to a *different* QuickBooks file, `ensureQboItem` falls through to
the mirror and returns the **old realm's** item id, then persists it as the new realm's mapping —
billing a line against whatever item happens to hold that id. `firstIncomeAccountId` has the same
defect. The loud half: `ingestItems` upserts on `(company, qboId)` while the table is also unique
on `(company, name)`, so the new realm's "labor" collides and aborts the sync.

Not fixed here: it needs `realm_id` on both tables plus a migration, and it is only reachable by
reconnecting to a different QuickBooks company — which no company has done. Tracked rather than
rushed into a release already carrying this much change.

## F8 (P1) — the "Default" badge showed a rate the server would never apply. FIXED

`hasDefault` ignored `usable`, so a MANUAL default set before connecting kept its green badge and
suppressed the "starts untaxed" line. The admin read the screen as configured while every estimate
was built at 0%. Given F1, that was the state of every connected company. Fixed: a default must be
usable to count, and the badge is hidden otherwise.

## F9 (P1) — deploy-order breakage between the two repos. FIXED BY SEQUENCING

The repos deploy independently, and frontend-first is the *likely* order (Amplify takes minutes;
the backend needs an image build plus a hand-run migration). Frontend-first, three things break:
the customer search returns the old row shape and renders blank clickable rows; "Add a new
customer" **creates the customer in the client's QuickBooks** and then loses it, leaving an orphan
that blocks every retry; and the customer-link PATCH 400s with "Nothing to update".

Resolution: **backend first, verified, then frontend** — recorded in the release order below.
Belt-and-braces client hardening (refuse a row without a numeric id) is deferred → **T-42**.

## F10 (P1) — a red gate is indistinguishable from a broken one. FIXED

`npm run typecheck` (`tsc -b`) exited 2 on a clean tree because of two pre-existing `src/lib/api.ts`
errors, so a genuine new error would have arrived as items 3 and 4 in a list nobody reads to the
end. Fixed: the script now filters that known baseline and fails on anything else. Verified both
ways — clean tree passes, a deliberate `const x: number = "str"` fails it.

## F11 (P1) — the sandbox proof predates the code it vouches for. DEFERRED → **T-39**

The recorded sandbox run wrote to the `raw_*_qb` tables this change drops. So `ingestCustomers`,
the rewritten `ingestSalesTax`, `pushCustomerToQbo` and every `ensureQboCustomer` branch have
**never executed against real Intuit data or a real database** — and F1 is exactly what the first
real sync would have surfaced. Now a task with an ID rather than a sentence.

## F12 (P1) — a failed estimate post is logged and forgotten. DEFERRED → T-17

Pre-existing, but newly load-bearing: `ensureCustomer` is now injected into that path, so the
swallowed failure can occur *after* a customer has been created in the client's books.

## Fixed without narrative

| # | P | Finding |
|---|---|---|
| F13 | P2 | `upsertSalesTax` set the new default **before** clearing the old one. The partial unique index is non-deferrable, so the first "make default" on a company that already had one raised 23505 and returned a raw Prisma message as a 400. Clear-then-set now, matching `setDefaultSalesTax`. |
| F14 | P2 | An omitted `isDefault` was written as `false`, so correcting a rate's percentage **silently cleared the company's default** and every later estimate started untaxed. Absent now means unchanged. |
| F15 | P2 | `sales_tax_qb` member rows were keyed without `salesTaxId`, so a state rate shared by two city groups reparented itself and left the other group's breakdown unable to add up. |
| F16 | P2 | `createCustomer` committed the local row before the QuickBooks push, so a refusal (fault 6240 — names are shared with vendors and employees) left an orphan that wedged the name: retry hit "already one of your customers", and completing the quote failed on the same duplicate forever. The row is now rolled back. |
| F17 | P2 | `searchCustomers` took an arbitrary `customer_qb` row with no realm filter, so after a reconnect the picker could present a **previous** realm's id as "synced". Now scoped to the connected realm; disconnected reports null. |
| F18 | P2 | `POST /qbo/customers` returned 409 when QuickBooks was disconnected, contradicting `createCustomer`'s deliberate null-connection support and making the client's "added (not to QuickBooks)" branch unreachable. |
| F19 | P2 | `schema.prisma` still declared the three models whose tables Phase 2 drops — a client method pointing at a relation that does not exist, and permanent `prisma db pull` drift. Removed. |
| F20 | P2 | `ratePercent` was parsed with `Number()`, so `null`, `""` and `[]` all became a silent **0% rate** — and "no rate configured" versus "a deliberate 0%" is the distinction that decides whether tax is declared to QuickBooks at all. Extracted as `parseRatePercent`. |
| F21 | P2 | Soft-deleted rows held their names against the unique key, so a deleted customer or rate permanently blocked a name the UI could not even show. Name lookups now honour `isDeleted`. |
| F22 | P2 | `taxGroupEffectiveRate` silently dropped members it could not resolve, returning a plausible understated percentage — and the old test **pinned that as correct**. It now refuses the code, logs it by name, and rejects a cascade outside the column's range instead of throwing mid-sync. |
| F23 | P3 | `quotes.customer_id` had no FK while Prisma declared the relation as if one existed. Added `ON DELETE SET NULL` — deleting a customer must not delete quotes. |
| F24 | P3 | Phase 2's irreversibility was undocumented, and "healthy" undefined. Both stated: the point of no return, the rollback recipe, and "one quote read and one estimate posted" rather than a health check. |
| F25 | P3 | The partial unique index covered soft-deleted rows, disagreeing with every read. Now `WHERE is_default AND NOT is_deleted`. |
| F26 | P3 | Four index names diverged from Prisma's derivation, guaranteeing permanent drift in a repo whose only record of production **is** `schema.prisma`. Aligned. |
| F27 | P3 | A redundant `@@index([companyId, name])` duplicated the unique on the same columns. Dropped. |
| F28 | P3 | `customerDisplayName` truncated *after* trimming, so a cut at 100 could reintroduce a trailing space — changing the name QuickBooks stores and causing the next sync to create the duplicate this path exists to prevent. |
| F29 | P3 | `qboConnected` ignored `realmId`, so the UI reported Connected while every sync and completion threw "no realm" later, where nobody could act on it. |
| F30 | P3 | `saveSalesTax` did not integer-validate the client's `id`, unlike its sibling; `NaN` reached Prisma and its message was returned to the caller. |
| F31 | P3 | A check-script assertion re-asserted `isAdminRole` and would have passed with `canManage` hard-coded. Replaced with assertions over the **route table**: every write route carries `requireAdmin`, the three reads a technician needs do not, and the OAuth callback is unauthenticated by design. |
| F32 | P3 | `quoteDto` emitted `customerId: undefined` against a type declaring `number | null`. |

## Deferred, with IDs

| ID | From | Why deferred |
|---|---|---|
| T-39 | F11 | Re-run the sync against the entity tables and record the result. **Blocks release.** |
| T-40 | F2 | The CRM lockout needs a product decision, not a patch. |
| T-41 | F7 | Realm-scoping the item/account mirrors needs its own migration; unreachable until a company reconnects to a different QuickBooks file. |
| T-42 | F9 | Client-side hardening against a stale server, beyond fixing the deploy order. |
| T-43 | — | No timeout or retry on any Intuit call. `serpapi.ts` already has the house pattern (`AbortSignal.timeout` + bounded backoff); `qbo.ts` is the outlier. A single 429 on a shared app discards a whole sync. |
| T-44 | — | The sync has no concurrency guard and does 4-5 DB round trips per row. A gateway timeout invites a second click, and two concurrent runs race the same upserts *and* the known unserialised token refresh. |
| T-45 | — | Partial sync failure is unrecorded, and `qboSyncedAt` then reports the failed run as a fresh success. |
| T-46 | — | The mirrors never converge downward: rows deactivated or deleted in QuickBooks stay active forever, so the item resolver can link a line to a dead item id. |
| T-47 | — | `queryAll` truncates silently at 50,000 rows and reports the partial count as the total. |
| T-48 | — | The estimate id is persisted *after* the QBO create, so a crash between them duplicates the estimate. `PrivateNote` already carries `CLARA quote <id>` and is never read back. |
| T-49 | — | Three check-script fixtures are cast `as any`, so `typecheck:scripts` cannot see DTO changes in them — the exact blindness that config was added to remove. |
| T-50 | — | `linkItem` swallows every error, not just the unique violation it documents. |
| T-51 | — | The customer typeahead does an unindexed case-insensitive scan per keystroke; needs a trigram index. |
| T-52 | — | The dev auth bypass is armed by the *absence* of `NODE_ENV=production` — fail-open. Should be an explicit positive opt-in. Overlaps T-13. |
| T-53 | — | Raw Intuit and Prisma error text is reflected to clients, and a customer's email address is written to the log line. |
| T-54 | — | `loadOwnedQuote` scopes by `userId` only, while the QBO post resolves its tenant from `quote.companyId`; the two diverge if a user is moved between companies. |

## Release order, from F6 and F9

1. Run **Phase 1** (expand + backfill) — before any deploy.
2. Merge and deploy **copilot-server**; confirm `GET /companies/sales-tax` returns `{taxSource, rates}`.
3. **T-39**: re-sync company 9 and check `source = 'QBO'`, one `customer_qb` row per customer per realm across two consecutive syncs, and Tucson at 9.1%.
4. Merge and deploy **technician-copilot**.
5. Exercise a quote read and an estimate post on the new image.
6. Only then run **Phase 2**, after its gate returns 0.


---

## Appended after the correctness reviewer returned

## F33 (P0) — the fix for F15 aborts the whole sync. FIXED

F15 correctly identified that `sales_tax_qb` member rows reparented themselves when a rate was
shared by two codes. The fix scoped the lookup by `salesTaxId` — but the database's unique key
was still `(company_id, realm_id, qbo_type, qbo_id)`, **without** `salesTaxId`. So the second
code's member insert no longer reparented the row; it collided with it, raised 23505 in an
uncaught `for` loop, and aborted `syncQboReferenceData` before accounts were ingested at all.

Silent wrongness traded for a hard stop, which is the better direction to fail — but it would
have failed for the sandbox's own data: AZ State 7.1% sits inside "Tucson", and adding a
"Phoenix" code makes the collision certain.

Fixed properly: `salesTaxId` is part of the key in `schema.prisma` and in the migration, and the
writes are plain upserts on it. Two things fell out of doing it correctly:

- Prisma **rejected** the explicit constraint name — 66 bytes against Postgres's 63-byte limit.
- The derived name Prisma actually uses is truncated to
  `sales_tax_qb_sales_tax_id_company_id_realm_id_qbo_type_qbo__key` (note the double underscore),
  now copied verbatim into the runbook.

The runbook gained the verification step that would have caught all of this:
`prisma migrate diff --from-empty --to-schema-datamodel`, compared against the hand-written SQL.

## F34 (P2) — a rate typed by an admin could be overwritten and relabelled. FIXED

The tax-code name fallback matched on name with no `source` filter, then wrote
`{source: "QBO", ratePercent, isActive: true}` over whatever it found. An admin types
"California 8.5%" before connecting; the company connects, and QuickBooks' "California" is 8.0%
— their row is rewritten in place, its percentage replaced and its provenance flipped. If it was
the default, the ingested rate **inherited `isDefault`**, breaking the rule that ingested rates
arrive as candidates. And `isActive: true` silently reactivated any rate an admin had turned off,
on every sync.

Fixed: the fallback matches `source: "QBO"` only, and the refresh no longer forces `isActive`.

## F35 (P2) — "8,5" became an 85% tax rate. FIXED

Both the client and `parseRatePercent` stripped commas rather than interpreting them, so `8,5`
became `85` — inside the accepted 0–99.9999 range, stored, and applied to customer money. `1,5`
became 15%. The success toast echoed only the name, so nothing on screen showed the number saved.
A comma is now a decimal separator.

## F36 (P2) — a customer deactivated in QuickBooks stayed billable. FIXED

`isActive` was written on create and never refreshed, so a customer deactivated in QuickBooks kept
being offered by the picker until an estimate was linked to it and QuickBooks rejected it at
completion. A regression from the entity split: the pre-change code carried `active` in its update
payload. Now refreshed on every sync — unlike the contact fields, which stay gap-fill-only.

## F37 (P2) — a hidden customer's name was refused but unpickable. FIXED

`createCustomer`'s duplicate check filtered neither `isActive` nor `isDeleted`, while the picker's
search filters both. A technician searching an inactive "Acme" saw "No customer matches that
name", tapped "Add a new customer", and got "already one of your customers — pick them from the
list instead" naming a list it was not in. No third option on that screen. A hidden match is now
revived and returned instead of refused.

## F38 (P2) — a PATCH carrying both a name and a customer discarded the name. FIXED

The overwrite guard tested the **stored** `customerName` rather than the pending one, so a request
setting both fields lost the typed name silently, behind a comment claiming it "never overwrites
what a technician typed".

## F39 (P2) — the picker could show results for a query the user had moved past. FIXED

The debounce cleared the pending timer but never sequenced the requests, so a slower broad query
could land after a narrower one and replace it — input reading "acme", list showing everything
starting with "a", and the technician picking the wrong customer. A request id in a ref now drops
any response that is not the latest, and the in-flight response no longer writes state after the
dialog closes.

## Appended deferrals

| ID | From | Why deferred |
|---|---|---|
| T-55 | correctness | `ensureQboCustomer`'s linked branch pushes blind, with none of the adopt-by-name protection the legacy branch has, so a customer added directly in QuickBooks dead-ends the quote until a full re-sync. |
| T-56 | correctness | The adopt-by-name upsert keys on `(customerId, realmId)` only and can violate the second unique key after a rename. |
| T-57 | correctness | The "Customer record" row shows the quote's free text, not the linked customer — the exact near-miss the picker exists to prevent. Needs the linked name on the DTO. |
| T-58 | correctness | `ensureQboItem`'s step 1 is one OR'd `findFirst` with no ordering, so the documented pricebook-first precedence is not what runs — one material can bill against two QuickBooks items. |
| T-59 | correctness | The item mirror is adopted without checking the item is still active in QuickBooks, then cached in the link table permanently. |
| T-60 | correctness | Ingested DisplayNames skip `customerDisplayName`, so a >100-character name can never be matched again by the paths that normalise; the name index is also case-sensitive while QuickBooks' is not. |
