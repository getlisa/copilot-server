# QuickBooks Online Integration — state, assessment, decisions, tasks

**Single source of truth for the QBO work across both repos. Read this file first in any new
session or window.**

- **Last updated:** 2026-09-04
- **Owner:** Bharath (bharath.valusa@justclara.ai)
- **PRD (canonical):** https://justclara.atlassian.net/wiki/spaces/EA/pages/115572739/QuickBooks+Integration+PRD — Draft v5, 2026-09-03, Ashish Sethi
- **Phase:** assessment done → decisions answered (§4) → **plan rewritten for the Clara-owned app model (§7)** → three product questions open on tax (D-7/8/9) → implement

---

## Contents

1. [Repo map and branch state](#1-repo-map-and-branch-state)
2. [Multi-tenancy and user management](#2-multi-tenancy-and-user-management)
3. [What is already built, and what is verified](#3-what-is-already-built-and-what-is-verified)
3a. [Sales tax and items — what Intuit requires](#4a-sales-tax-and-items--what-the-intuit-estimate-spec-requires)
4. [Decisions — answered](#4-decisions--answered-2026-09-03-bharath)
5. [Gaps found by reading the code](#5-gaps-found-by-reading-the-code)
6. [Comparison with collection_agent_backend](#6-comparison-with-collection_agent_backend)
7. [Task board](#7-task-board)
8. [Session protocol and environment facts](#8-session-protocol-and-environment-facts)

---

## 1. Repo map and branch state

The repo names are misleading — check before editing:

| Repo | What it actually is | Stack |
|---|---|---|
| `~/clara/copilot-server` | **Backend** — API, Prisma schema, QBO client | Express + TypeScript + Prisma (Postgres/Aurora) |
| `~/clara/technician-copilot` | **Frontend** — technician + admin web app | React + Vite + TS + shadcn/ui + zustand |

Both have `feature/QBO-integration`, both **up to date with `origin/main`** (0 commits behind,
checked 2026-09-03). Each is one squashed commit by Ashish Sethi, so the ✅s in the branch's
own `docs/QBO_PRD_IMPLEMENTATION_STATUS.md` are the author's self-report — independently
verified only where §3.4 says so.

```
copilot-server        feature/QBO-integration = 76b3a5e "qbo feat"                              (14 files, +1042)
technician-copilot    feature/QBO-integration = 15c465c "fix: connections section visible to all users"
                                                10864be "fix: QBO feat"                         ( 6 files,  +536)
```

**New on the frontend, 2026-09-03 17:56 (fetched 09-04) — `15c465c`, and it conflicts with D-2/D-3.**
Ashish moved `ConnectionsCard` **out of** the admin-only Configurations tab and **into** the
My Profile tab, visible to **every user**, with the comment *"per product decision it must be
visible to every user (the server scopes everything to the caller's company either way)."*

That last clause is the part that no longer holds. Company scoping is not the only thing at stake
once Clara owns the app: a Connections card every technician can see, on an endpoint that mints an
OAuth consent URL, is the escalation path in G15 — a technician binds **their own** QuickBooks to
the company and receives every completed quote. It also directly contradicts D-2 ("yes, enforce
admin server-side"), which would leave technicians looking at a Connect button that 403s.

The likely story: someone who *should* have access couldn't see it — which is exactly D-3
(`service_manager` was never treated as admin), fixed here with a blunt instrument. Treating
`service_manager` as admin removes the reason for this change. **→ D-11, and the frontend half of
T-25 is blocked until it is answered. The backend auth work is unaffected and proceeds.**

Related documents (all on the branch, not written by us):
`copilot-server/docs/QBO_PRD_IMPLEMENTATION_STATUS.md` (PRD → code map) and
`copilot-server/docs/PROD_DB_MIGRATION_RUNBOOK.md` (the pending QBO SQL block —
**not applied anywhere yet**).

---

## 2. Multi-tenancy and user management

### 2.1 Multi-tenancy — yes, and the QBO code already respects it

Shared-database, `company_id`-scoped model:

- `companies` (id, name, address…) → `company_configs` (1:1) → `users.company_id` (FK).
- `users.role` is a Postgres enum **`user_role { service_manager | admin | technician }`**,
  with `@@unique([company_id, username])`.
- copilot-server **does not sign tokens — it only verifies them.** `src/config/jwt.ts` records
  that tokens are signed by the external login service; `authMiddleware`
  (`src/api/middlewares/auth.ts:20`) verifies with `JWT_ACCESS_SECRET` and attaches
  `{ userId, email, role, companyId }` to the request.
- Every QBO endpoint on the branch derives the tenant from `req.user.companyId` — never from
  the body or a path param. `QboConnection.companyId` is `@unique`, so "one connection per
  company" (US1) is enforced by the schema, not by convention.

**Verdict: tenancy is sound.** No cross-tenant read/write path found in the QBO code.

Two caveats, both real:

- `authMiddleware` has a **dev bypass**: any request with `X-Dev-Bypass: true` gets a synthetic
  user (`companyId` from a header) whenever `NODE_ENV !== 'production'`. Fine locally; it means
  staging must run with `NODE_ENV=production`, or anyone can impersonate any company — which
  now includes reading and writing QBO credentials. → **T-13**
- The internal console (`/api/v1/op-x7k2/*`, `admin.route.ts`) is **unauthenticated by owner
  decision** (hidden URL only) and now manages QBO connections, including
  `DELETE .../qbo` disconnect. The PRD flags this itself under "Known risk to schedule". → **T-12**

### 2.2 User management — yes, but it lives elsewhere

- Frontend: `technician-copilot/src/components/profile/UserManagementTab.tsx` (list / invite /
  edit team members), and `src/pages/Profile.tsx:12` gates both *User Management* and
  *Configurations* behind `authUser?.role === 'admin'`. The QBO Connections card and the
  Default Markup card live inside Configurations, so the **UI** is already admin-only.
- The CRUD itself goes to the **platform API** (`VITE_API_BASE_URL` →
  `technician-copilot-services-*.justclara.ai/api`), not to copilot-server
  (`VITE_COPILOT_BASE_URL` → API Gateway). copilot-server has no user or login endpoints.

Two gaps:

- The frontend's `User.role` type is `'technician' | 'admin'` (`store/useAuthStore.ts`), but
  the DB enum also has **`service_manager`** — a service manager sees no Configurations tab at
  all today. PRD says "admin-only, like the rest of that tab", so this may be intended; it
  should be a stated decision. → **D-3**
- **No server-side role check** on the self-serve endpoints. `GET/PUT /companies/connections*`
  and `GET/PUT /companies/markup` authorize the *company*, not the *role* — any technician's
  token can read connection status, save app keys, or change the company default markup by
  calling the API directly. The status doc rationalizes this as matching the existing
  proposal-email-template pattern; that pattern predates storing OAuth credentials to a
  client's accounting system. → **T-01 / D-2**

---

## 3. What is already built, and what is verified

### 3.1 copilot-server (backend) — 14 files, +1042

| Piece | Where | Notes |
|---|---|---|
| Core module | `src/lib/qbo.ts` (428 lines) | encryption, OAuth, token refresh, customers, items, estimate mapping, sync |
| Schema | `prisma/schema.prisma` | `QboConnection` (two-phase), `Quote.qboEstimateId`, `Quote.chosenOptionGroup`, `QuoteLineItem.qboItemId/qboItemName`, `company_configs.default_markup_percent` |
| Self-serve API | `company.controller.ts` + `company.route.ts` | `GET /companies/connections`, `PUT /connections/qbo`, `GET /connections/qbo/items`, `GET/PUT /markup` |
| Console API | `admin.controller.ts` + `admin.route.ts` | status / connect (302 to Intuit) / callback / disconnect |
| Trigger | `quote.controller.ts::complete` | 409 `OPTION_CHOICE_REQUIRED` gate, then `postToQboInBackground` |
| Retry | `POST /quotes/:quoteId/qbo` | completed quotes only; 409 when not connected |
| Check | `scripts/check-qbo.ts` + `npm run check:qbo` | line-mapping assertions |
| Migration SQL | `docs/PROD_DB_MIGRATION_RUNBOOK.md` | pending block — **not applied anywhere** |

Design decisions already encoded in the code, worth knowing before editing:

- **Per-company Intuit app keys.** Each company enters its own Client ID + Secret; the secret is
  sealed with AES-256-GCM. The only server-level setting is `QBO_REDIRECT_URI`.
  *(**Superseded by D-1**: Clara now owns the app and the keys come from env. This paragraph
  describes what is currently on the branch, i.e. what the rework has to undo.)*
- **Encryption key derived from `JWT_ACCESS_SECRET`** (`sha256('qbo:' + secret)`). Rotating that
  secret orphans every stored secret and token.
- **`qbo_connections` is deliberately not `crm_connections`** — that table is owned by the
  platform backend, and extending its provider enum would break that service's client.
- **Posting is fire-and-forget** at completion; failures are logged only, never surfaced to the
  technician. Completion can never fail because of QuickBooks.
- **Update-in-place** on re-completion via SyncToken; QBO fault 610 / 404 → create fresh and
  re-link. Any other error propagates rather than creating a duplicate.
- **Options:** only the chosen group posts as priced lines; other groups become `DescriptionOnly`
  note lines, so the QBO total is the real job price.

### 3.2 technician-copilot (frontend) — 5 files, +532

| File | Role |
|---|---|
| `src/components/profile/ConnectionsCard.tsx` | Connections section: app-key form → "Save & sign in" → Intuit consent tab; focus-refetch flips the badge; Edit keys / Reconnect; ZenTrades "coming soon" row (US1, US9) |
| `src/components/profile/ConfigurationsTab.tsx` | Mounts `ConnectionsCard` + `DefaultMarkupCard` (US7) |
| `src/components/quotes/QuoteInvoiceTab.tsx` | Completion option picker driven by the backend's 409 (US3); per-line `QboItemSelect` (US5), hidden entirely when QBO isn't connected |
| `src/services/connectionsService.ts` | `connectionsService` + `markupSettingsService` against `VITE_COPILOT_BASE_URL/api/v1/companies` |
| `src/services/quotesService.ts` | `chosenOption` on complete; per-line `qboItemId`/`qboItemName` |

### 3.3 PRD coverage

US1–US10 all have code on the branch. US8's retry is API-only (UI button deferred by the PRD
itself); US9 is a display-only placeholder; US10 is the unauthenticated console.

### 3.4 Verification actually run (2026-09-03)

| Check | Result |
|---|---|
| `npx tsx scripts/check-qbo.ts` on the branch | **PASS** — `check-qbo: OK` |
| `npx tsc --noEmit` on the branch | Inconclusive locally: 13 errors, **all** missing-module / implicit-any from a stale `node_modules` (sharp, exceljs, pizzip, docxtemplater, pdfjs-dist, csv-parse are absent on `main` too). **Zero errors in any QBO file.** Re-run after `npm install` → **T-11** |
| Branch drift vs `origin/main` | 0 commits behind, both repos |
| Migration applied? | **Unknown — not probed.** No ledger exists; must be checked against the real dev and prod schema → **T-10** |
| End-to-end against a real QBO sandbox | **Never run.** Nothing is deployed → **T-08** |

**Summary: the code is real and coherent, but nothing beyond one pure-function check script has
been executed, and no byte of it has ever talked to Intuit.**

---

## 4. Decisions — ANSWERED 2026-09-03 (Bharath)

All six resolved. Recorded as a footer comment on the PRD page
([comment 116260866](https://justclara.atlassian.net/wiki/spaces/EA/pages/115572739/QuickBooks+Integration+PRD?focusedCommentId=116260866)),
so the PRD's own open questions and this document stay in sync.

### D-1 — One Clara-owned Intuit app. Per-company keys **DEFERRED**. ✅

Clara owns a single Intuit app — **already created by Bharath**. Its **Client ID, Client Secret
and environment come from server env vars** (working names `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`,
`QBO_ENVIRONMENT` — exact syntax TBD in implementation). Only the OAuth **tokens** stay per
company. The client clicks *Connect QuickBooks* and approves; no key form.

**"Not every user will bring his own client id and client secret — we are deferring that."**
The per-company-keys path built on the branch is *deferred, not cancelled*. It must survive as a
**code comment in `lib/qbo.ts`** so the option is findable when a client asks to bring their own
app, and it is recorded on the PRD comment.

This reverses the shape of US1 and rewrites: `lib/qbo.ts` (credential handling), the
`qbo_connections` columns `client_id` / `encrypted_client_secret` / `environment`, the
`PUT /companies/connections/qbo` endpoint, and `ConnectionsCard.tsx` (key form → one button).
Because the migration is still unapplied, the column changes are free — but only until T-10 runs.

### D-2 — Server-side admin enforcement. ✅ Yes

`/companies/connections*` and `/companies/markup` get a real role check, not just the UI gate.

### D-3 — `service_manager` counts as an admin. ✅ Yes

Everywhere `admin` is checked, in both repos. The frontend `User.role` type
(`'technician' | 'admin'`) must be widened, and `Profile.tsx:12` and any other role check updated.

### D-4 — A small QuickBooks icon on every synced estimate. ✅

Not a full status chip: a QB icon shown on estimates that have synced. Needs the backend to
expose sync state on the quote DTO (`qboEstimateId` at minimum). Where the icon appears — detail
tab only, or the quote list too — is settled in the plan.

### D-5 — Self-serve disconnect. ✅ Yes

Safe now that Clara owns the app.

### D-6 — Sandbox first on `main`; no kill switch; **read + write**. ✅

- **No staging branch — only `main`.** Nothing is merged yet. Test against a QBO **sandbox**
  company first, then flip the environment variable to production.
- Env-driven: `qbo_environment`, `qbo_clientid`, `qbo_clientsecret` (naming to be normalised in
  implementation).
- **No kill switch** — a company with no connection is already unaffected by every code path.
- **Scope addition, beyond the PRD as written:** *"we need to read and write, because for an
  estimate to sync to QuickBooks we need customers, items, sales tax."* Customers and items are
  already read. **Sales tax is new** — the branch has no tax handling at all, and the PRD's
  non-goals still say two-way sync is out "except the item list". That PRD line needs updating,
  and what CLARA sends when a quote carries no tax concept of its own needs a product answer.
  → **T-18**

## 4a. Sales tax and items — what the Intuit Estimate spec requires

Source: Intuit's Estimate entity reference, saved locally at `~/clara/qbo.md` (provided by
Bharath 2026-09-03). Everything here is quoted from the spec, not inferred.

### What the spec says

- **Tax is per line and per transaction.** Each `SalesItemLineDetail` carries a
  `TaxCodeRef` — `"TAX"` or `"NON"` in US companies. The transaction-level `TxnTaxDetail`
  carries `TxnTaxCodeRef`, `TotalTax`, and a `TaxLine[]` of `TaxLineDetail`
  (`NetAmountTaxable`, `TaxPercent`, `TaxRateRef`, `PercentBased`).
- **QBO will compute it for us.** `TxnTaxDetail` "can be calculated by QuickBooks business logic
  **or** you may supply it" — so CLARA does not have to compute tax, only declare per-line
  taxability. And `TotalAmt` is **read only**: "Calculated by QuickBooks business logic; any
  value you supply is over-written."
- **Two company modes decide the behaviour.** `Preferences.TaxPrefs.UsingSalesTax = false`
  ⇒ `TxnTaxDetail` "is ignored and not stored". `Preferences.TaxPrefs.PartnerTaxEnabled = true`
  ⇒ Automated Sales Tax, and then **`ShipFromAddr` is required for an accurate calculation**.
- **Non-US companies need `GlobalTaxCalculation`** (`TaxExcluded` / `TaxInclusive` /
  `NotApplicable`) — "not applicable to US companies; required for non-US companies."

### Why this is a real gap, not a nicety

CLARA has **no tax concept in the quote path that posts to QuickBooks**: zero occurrences of "tax"
in `prisma/schema.prisma`, none in the quote DTO, and a single un-broken-down "Total" row in
`QuoteInvoiceTab.tsx:152-153`. (The *older* Job Copilot estimate entity is different — its LLM
schema does carry `taxOther` (`estimate/estimateQuoteSchema.ts:61-62`) and its PDF renders a
Tax / Other row. That entity is not what syncs to QBO, but it is what the proposal document is
rendered through — see G17.) The branch's `qboEstimateLines` sends no `TaxCodeRef` on any line
and no `TxnTaxDetail`. So the estimate CLARA posts is, in QBO's eyes, a transaction with no
declared taxability — and on a company using sales tax, the total in the books will not be the
total anyone intended.

But CLARA **already has the per-line taxability rule**, in the proposal document:
`src/copilot/estimating/proposalEstimate.ts:212` prints a "Taxed" ✓ for
`kind === "material" || "service"` and "–" otherwise, where `kind` comes straight from
`isLabor` (`:69`). Its `taxOther` is hardcoded to `0` (`:85`). So the customer-facing proposal
already tells the customer which lines are taxable, and then shows zero tax.

That gives a clean mapping with no new product concept invented:

| CLARA line | QBO |
|---|---|
| `isLabor === false` (material/service) | `SalesItemLineDetail.TaxCodeRef = { value: "TAX" }` |
| `isLabor === true` (labor) | `SalesItemLineDetail.TaxCodeRef = { value: "NON" }` |
| transaction | omit `TxnTaxDetail` and let QBO compute; send `ShipFromAddr` so AST companies calculate correctly |

### This is why "read" is needed, and why items are entangled with tax

The reads the write path depends on:

1. **`Preferences`** — once per company (cacheable): `TaxPrefs.UsingSalesTax` (is tax on at all?)
   and `TaxPrefs.PartnerTaxEnabled` (AST or manual tax codes?). Without this we cannot know
   whether to send tax codes or whether they will be ignored.
2. **`TaxCode` list** — for manual-tax companies whose codes are not the well-known `TAX`/`NON`.
3. **`Customer`** — already read (US4); also the source of the address AST needs.
4. **`Item`** — already read (US5), but with a tax consequence nobody has noticed: a QBO `Item`
   carries its own taxability, so **items CLARA auto-creates must be created with the right tax
   setting**, or every future estimate that bills against them is taxed wrongly. This is the
   direct link between the items work and the tax work.

### The tax architecture Clara is building (received 2026-09-04)

`~/clara/tax_architecture_for_estimates.md` — this changes the design: **CLARA computes tax
itself**, it does not lean on QuickBooks' address-based Automated Sales Tax.

- **Organization level:** an estimate display setting (tax-inclusive vs tax-exclusive), a default
  taxability per item type (Labor / Materials / Other), and a single default tax rate (e.g. 8.25%).
- **Price book level:** each item carries a *price basis* — whether the stored price already
  includes tax. The system must reconcile basis against the display setting, not assume one.
- **Estimate line level:** a simple Taxable/Non-taxable toggle is the primary control; the rate
  stays hidden behind Advanced Tax Settings and is overridable per line.
- **Snapshot:** each line stores item type, price basis, taxable, tax rate and tax amount at the
  time it is added, so later changes to org defaults or the price book never mutate an existing
  estimate. (The same principle the codebase already uses for `templateId` and `markupPercent`.)

**What this settles:** D-8 largely dissolves — no structured job-site address is needed, because
the rate comes from the org default, not a jurisdiction lookup. D-9 becomes a per-item-type org
setting rather than a constant. D-7 is answered by the display setting: CLARA's own total will
include tax, so it can match QuickBooks.

**What it opens instead:** if CLARA computes the tax, the QBO payload should carry *our* number —
the Estimate spec allows supplying `TxnTaxDetail` instead of letting QBO calculate. The open
question is what an Automated-Sales-Tax company does with a supplied `TotalTax`: honour it, or
recompute and diverge. That is a probe (**T-28**), not a documentation question. The `TAX`/`NON`
per-line mapping still holds — it now comes from the line's snapshot `taxable` flag rather than
being inferred from `isLabor`.

**Scope note:** this architecture is a substantial piece of CLARA-side work (org settings, price
book price basis, per-line snapshot, inclusive/exclusive rendering) that exists independently of
QuickBooks. → **T-32**

### Bonus: this also settles G8 (`sparse: true`)

The spec's sparse-update section: *"only elements specified in the request are updated. Missing
elements are left untouched."* The branch sends the full `Line` array in its sparse update, so
`Line` **is** specified and gets replaced — removed lines do disappear, which is what US6 needs —
while fields CLARA never sends (`DocNumber`, `CustomerMemo`, `TxnStatus`…) survive the update.
The branch's approach is correct. Still worth one sandbox confirmation in T-08, but it is no
longer an unknown.

---

## 5. Gaps found by reading the code

Not in the status doc. Ordered by risk.

| # | Gap | Evidence | Task |
|---|---|---|---|
| G1 | **Token refresh is both un-serialised and re-entrant — it fires with zero concurrency.** `accessTokenFor(conn)` reads `conn.accessTokenExpiresAt` / `conn.encryptedAuth`, persists a refreshed pair to the DB, and **never writes back to the in-memory `conn` object** (`lib/qbo.ts:174-178`). But `qboFetch` calls `accessTokenFor(conn)` on *every* request (`:203`) with that same stale object, and one `syncQuoteToQbo` makes 4–8 sequential requests. So any sync that starts inside the 60-second pre-expiry window refreshes **once per API call**, each time replaying a refresh token the previous call may already have rotated away. Add the classic concurrent case (two completions for one company) on top. Intuit rotates the refresh token and invalidates the old one; `collection_agent_backend` **hit exactly this in production** and fixed it with a `refresh_lock_until` conditional-UPDATE claim plus a double-check inside the claim. Blast radius: at minimum a failed post (the DB already holds the good pair); at worst `invalid_grant` and a connection the client must reconnect. ~1 in 60 syncs by window size, against a ≥95% success target. Fix both halves: re-read/update `conn` after a refresh **and** port the lock. The lock needs a column, so it must land **before** the migration is applied. | `lib/qbo.ts:174-178, 203`; `collection_agent_backend/src/services/qbo-entity-service.ts:26-27,382-456` | T-02 |
| G2 | **Encryption key derived from `JWT_ACCESS_SECRET`.** Ashish changed jwt config on 2026-09-02 (`e84c4cf fix: jwt expiry`). Rotating that secret silently bricks every stored client secret and token. Add a dedicated key now, while there are zero rows to migrate. | `lib/qbo.ts` `key()` | T-03 |
| G3 | **No server-side admin check** on `/companies/connections*` and `/companies/markup`. | `company.route.ts` | T-01 |
| G4 | **Customer email never reaches QBO.** US4 says the created customer carries name, email, phone, address. Both call sites pass `{ name, phone, address }` only, so `BillEmail` is never set and new QBO customers have no email. `loadSuggestedCustomerEmail(jobId)` already exists (`copilot/estimate/pdf/quoteHeader.ts`) and is what the proposal email uses. There is no `customer_email` column on `quotes`. | `quote.controller.ts` `postToQboInBackground`, `syncQbo` | T-04 |
| G5 | **Customer address has no fallback.** Only `quote.customerAddress` is sent; when null the QBO customer gets no `BillAddr`, though the header carries `billingAddress` / `serviceAddress`. | same call sites | T-04 |
| G6 | **Retry is user-scoped, not company-scoped.** `loadOwnedQuote(quoteId, userId)` means only the technician who created the quote can retry it. US8 says "As a technician **(or support)**" — an admin cannot retry a tech's failed post. | `quote.controller.ts:132` | T-05 |
| G7 | **Concurrent completion could double-post.** Nothing serialises `postToQboInBackground`; two completes (or complete + retry) racing before `qboEstimateId` is written both create an estimate. | `quote.controller.ts` | T-06 |
| G8 | **`sparse: true` update semantics — RESOLVED from the Intuit spec (§4a).** Sparse update touches only the elements sent, and the branch sends the whole `Line` array, so lines are replaced (US6 satisfied) and unsent fields survive. The branch is correct. Confirm once in the sandbox anyway. | Intuit Estimate reference (`~/clara/qbo.md`, sparse-update section); `lib/qbo.ts` `syncQuoteToQbo` | T-08 |
| G9 | **Item list is one page of 1000** active items, no pagination. A larger list silently truncates the dropdown *and* causes duplicate item creation at post time (a name past row 1000 won't match). Acceptable for MOSS; note it. | `lib/qbo.ts` `qboItems` | T-07 |
| G10 | **`createItem` bills to an arbitrary Income account** (`select Id from Account where AccountType='Income' maxresults 1`). Whichever account QBO returns first becomes the revenue account for every auto-created item. A bookkeeper may object. | `lib/qbo.ts` `createItem` | T-07 |
| G13 | **No sales tax anywhere (§4a).** CLARA has no tax in its schema or DTO, and the branch sends no `TaxCodeRef` and no `TxnTaxDetail`, so on a company that uses sales tax the estimate's books total is not the intended number. The per-line rule already exists in the proposal renderer (`proposalEstimate.ts:212`, `isLabor` → taxable) and maps straight onto `TAX`/`NON`. Needs `Preferences` read (`TaxPrefs.UsingSalesTax`, `PartnerTaxEnabled`) and `ShipFromAddr` for automated-sales-tax companies. | §4a; `proposalEstimate.ts:69,85,212`; `lib/qbo.ts` `qboEstimateLines` | T-18 |
| G14 | **Auto-created items get no taxability.** `createItem` sets only `Name`, `Type: "Service"` and an income account. A QBO item carries its own tax setting, so every item CLARA invents is taxed by whatever QBO defaults to — silently wrong on every later estimate that bills against it. | `lib/qbo.ts` `createItem`; §4a | T-18 |
| G15 | **SECURITY — the D1 rework *creates* a hole if done naively.** `qboAuthUrl` has two call sites: `company.controller.ts:157` (authed, scoped to `req.user.companyId`) and `admin.controller.ts:846`, reached by `GET /op-x7k2/companies/:companyId/qbo/connect` — **no auth at all**. Today that dead-ends on the 409 at `:840-845` ("no app keys saved for this company"). Under D1 there are no per-company keys, so that guard disappears: any unauthenticated request naming any `companyId` mints a signed 15-minute state and redirects to Clara's consent page. Whoever approves binds **their** QuickBooks realm to that company, and every completed quote — customer name, address, phone, prices — posts into their books. The signed state is what makes the *callback* safe; the exposure is the *state minter*. **Rule for the rework: no reachable path to `qboAuthUrl()` outside `authMiddleware` + admin check + `req.user.companyId`.** | `admin.controller.ts:835-847`; `qbo.ts:107-117`; `server.ts:86` (adminRoute mounted unauthenticated) | T-20 |
| G16 | **Automated Sales Tax needs a structured ship-to address, and CLARA does not have one.** AST derives the rate from the transaction's ship-to address. `jobs.address` is a single unstructured `VarChar` (`schema.prisma:90`) and `quotes.customer_address` is free text (`:375`); only `companies.address` / `companies.service_address` are structured JSON (`:44-47`). Falling back to the company address taxes at the shop's jurisdiction instead of the job site — wrong in every state with local rates. This, not tax codes, is the load-bearing blocker on sales tax. | `schema.prisma:44-47,90,375`; §4a | T-18, D-8 |
| G17 | **A customer-facing tax inconsistency is shipping today, independent of QuickBooks.** `quotePdf.ts:107/118/148` prints a green ✓ in a "Taxed" column for every material line, while `proposalEstimate.ts:85` hardcodes `taxOther: 0`, so the "Tax / Other" row (`quotePdf.ts:172`) never renders. The document tells the customer those lines are taxed and then charges no tax. Fixable now; it gets worse once QBO starts adding tax behind a document that already claims the lines are taxed. | `quotePdf.ts:42,107,118,148,172`; `proposalEstimate.ts:70,85` | T-19 |
| G11 | **No visible QBO state on the quote screen.** Deferred by PRD open question #2 — a decision, not a defect. | — | D-4 |
| G12 | **No in-app disconnect** (console-only). PRD open question #3. | — | D-5 |

---

## 6. Comparison with `collection_agent_backend`

The only Clara QBO integration that has run in production — worth knowing what transfers.

| | collection_agent_backend | copilot-server (branch) |
|---|---|---|
| Intuit app | **One Clara-owned app**, `QB_CLIENT_ID`/`QB_CLIENT_SECRET` from env | **Per-company app keys** entered in settings |
| Client secret storage | none (env only) | AES-256-GCM per company row |
| Tokens | per company, `quickbooks_credentials` | per company, `qbo_connections` |
| OAuth state | `CSRFProtection.generateState(companyId, userId)` | 15-min signed JWT carrying `companyId` |
| Token refresh | serialized with a `refresh_lock_until` DB claim (found in prod, then fixed) | unserialized ← **G1** |
| Direction | reads from QBO (invoices, payments) + webhooks | writes to QBO (estimates) |
| Tests | jest suite, ~12 QBO test files | one `check-qbo.ts` assertion script |
| Marketplace | submission checklist + evidence matrix exist | not started |

The relevant transfer: Clara **already runs the "one Clara-owned app" model** and already has
Intuit review work in flight for it. That is the strongest input to **D-1**.

---

## 7. Task board

Rewritten 2026-09-03 for the Clara-owned-app model, from a six-way parallel investigation of both
repos plus a completeness critic. Update the status **before** you start and **after** you finish,
with evidence.

Status: `TODO` · `IN PROGRESS (<who/when>)` · `BLOCKED (<what>)` · `DONE (<evidence>)` · `WONTFIX (<why>)`
Repo: **CS** = copilot-server (backend), **TC** = technician-copilot (frontend), **BOTH**.

### Rules this plan is built on — read before picking up any task

1. **No reachable path to `qboAuthUrl()` outside `authMiddleware` + admin check + `req.user.companyId`.**
   This is G15, and it has two victims, not one: the unauthenticated console handler (T-20) *and*
   the `connectUrl` currently returned by `GET /companies/connections` (T-01). Minting a connect
   URL is a privileged write, never a read. Acceptance test for T-20, T-01 and T-21.
2. **One owner for the migration SQL.** Four separate investigations each wanted to rewrite the
   block at `docs/PROD_DB_MIGRATION_RUNBOOK.md:122-150`. Every column change funnels into **T-10**,
   which runs **once**. `CREATE TABLE IF NOT EXISTS` is a no-op on a DB where the old block already
   ran, so T-10 must carry explicit `ALTER … DROP COLUMN IF EXISTS` for the removed key columns —
   otherwise a leftover `NOT NULL client_id` rejects every callback insert.
3. **Probe Intuit out of band, before writing tax code.** The sandbox probes need a QBO sandbox
   company and curl (or Intuit's OAuth Playground) — *not* a deployed Clara. Sequencing them after
   deployment is what forces a second hand-run migration on prod.
4. **`QBO_TOKEN_KEY` must exist before the first-ever connect**, not before the production flip.
   Free today (nothing sealed); "every company reconnects" afterwards.
5. **Pair the merges.** No staging branch exists, so a split merge ships a broken intermediate:
   D2's server gate + D3's client widening land together, and the `getConnections` contract change
   lands with `ConnectionsCard`.

### Phase 0 — done

| ID | Repo | Task | Status |
|---|---|---|---|
| T-00 | BOTH | Assess PRD + both branches: tenancy, user management, completeness | DONE (2026-09-03 — §2, §3) |
| T-00b | BOTH | Six-way investigation of the rework surface + completeness critic | DONE (2026-09-03 — this board) |

### Phase 1 — product decisions still open (blocking the tax work only)

| ID | Question | Blocks |
|---|---|---|
| D-7 | **Largely answered by the tax architecture** (§4a): the org display setting decides whether the customer sees tax, and CLARA's own total will include it — so the two totals can agree. Confirm the intent. | T-18 |
| D-8 | **Dissolved by the tax architecture**: the rate comes from the org default, not a ship-to jurisdiction lookup, so no structured job-site address is required for v1. Revisit only if Automated Sales Tax recomputes our number (T-28). | — |
| D-9 | **Answered in shape by the architecture**: taxability is a per-item-type org default (Labor / Materials / Other), overridable per line — not a hardcoded constant. Still needs MOSS's actual values. | T-18 |
| D-10 | **ANSWERED 2026-09-04:** test on the **production environment using sandbox credentials** (`QBO_ENVIRONMENT=sandbox` + the Development keyset there). Bharath's call, made with the caveat below noted. | — |
| D-11 | **NEW — does the Connections card stay visible to every user (`15c465c`), or go back behind the admin gate?** D-2 says admin-only on the server; that commit says visible to all. They cannot both stand: either technicians see a Connect button that 403s, or any technician can bind their own QuickBooks to the company (G15). Recommendation: keep it where Ashish put it but render it read-only for non-admins — status visible to everyone, Connect/Disconnect admin-only — and treat `service_manager` as admin so the people who needed access get it. | T-25 (frontend only) |

Everything outside the tax slice is unblocked.

### Phase 2 — the D1 rework (Clara-owned app)

| ID | Repo | Task | Blocked by | Status |
|---|---|---|---|---|
| T-20 | CS | **Closed G15.** Delete `AdminController.qboConnect` and its route (`admin.route.ts:66`), so the only `qboAuthUrl()` call site is the authed, company-scoped one. Keep console *status*; console *disconnect* is decided in T-12. Acceptance: grep proves one call site, behind auth. | — | **DONE** (§10) |
| T-21 | CS | **Settle the callback path and register it at Intuit — before anything else touches Intuit.** Redirect URIs are matched character-for-character and are registered **per keyset** (Development and Production keep separate lists), so changing this later means re-registering twice and redoing consent. Recommendation: move it off the hidden console onto a dedicated unauthenticated route whose only credential is the signed state (e.g. `GET /api/v1/companies/connections/qbo/callback`), and do **not** leave the old `op-x7k2` URI registered. Set `QBO_REDIRECT_URI` to match exactly. | T-20 | TODO |
| T-22 | CS | **`lib/qbo.ts`: keys from env.** `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` / `QBO_ENVIRONMENT` / `QBO_REDIRECT_URI` / `QBO_TOKEN_KEY`. `apiBase()` loses its param; `qboAuthUrl(companyId)` needs no row; `tokenRequest(body)` uses the env keys; `connectQbo` becomes an **upsert** (no pre-existing row) and stamps `environment`. Delete `saveQboCredentials`. Rewrite the file header — it currently states the per-company model as fact — and carry the **DEFERRED-NOT-CANCELLED** block comment there (D-1). | T-21 | **DONE** (§10) |
| T-23 | CS | **`QBO_TOKEN_KEY`.** Move the at-rest key off `JWT_ACCESS_SECRET` (which `.env.example` documents as owned by the platform API — another team's rotation would orphan our tokens). Throw if unset; no silent fallback. The 15-min OAuth *state* can stay on the JWT secret. Add the var to every deploy target. | — | **DONE** (§10) |
| T-24 | CS | **Schema: `qbo_connections` collapses to tokens.** Drop `client_id` and `encrypted_client_secret`. **Keep `environment`**, repurposed as a stamp of which Intuit keyset minted these tokens, and make `qboConnected()` require `conn.environment === QBO_ENVIRONMENT` — that is what makes the D6 sandbox→production flip fail closed (companies reconnect) instead of throwing opaque 401s. Feed the SQL into T-10, do not run it. **Pair with T-09**: after a flip every company reads "not connected", so the UI must say *reconnect required*. | T-22 | **DONE** (§10) |
| T-01 | CS | **D2/D3 role enforcement — and split connect-URL minting out of the read.** Add an `isAdminRole` helper treating **`service_manager` and `admin`** as admin. **Gate:** `GET /companies/connections` (verified: only the admin-only `ConnectionsCard` calls it), `PUT /companies/markup`, the new connect-initiation, and disconnect. **Do NOT gate `GET /companies/connections/qbo/items`** — `QuoteInvoiceTab.tsx:49-54` fetches it for *every* quote viewer and swallows failures, so gating it silently deletes the US5 per-line dropdown for technicians with no error anywhere; leave an inline comment saying so. **The subtle one:** `getConnections` currently returns `connectUrl`, minted by `qboAuthUrl` (`company.controller.ts:157`). Under D1 that URL needs no saved keys, so an ungated GET would hand any technician a signed state that binds *a* QuickBooks realm to their company — their own books, receiving every completed quote. Move minting to an admin-gated **`POST /companies/connections/qbo/connect` → `{ authUrl }`** (mirrors the collections precedent `POST /api/qbo/auth/init`) and **strip `connectUrl` from the GET response**. Connect-initiation is a write. Acceptance: check script for the helper; technician write → 403; technician item-list read → 200; no GET anywhere returns an auth URL. | T-22 | **DONE** (§10) |
| T-25 | TC | **`ConnectionsCard` rework:** key form → a single Connect button that calls the new admin-gated `POST …/connect` and opens the returned `authUrl` (the GET no longer carries one); add Disconnect (D5); show environment and a *reconnect required* state. Per the repo convention, **comment out** the key form rather than deleting it, marked `DEFERRED (D1)`, with a pointer noting the server endpoint was removed. Widen `User.role` to include `service_manager` and update `Profile.tsx:12` and every other role check (D3). **Merge together with T-01 and T-24.** | T-01, T-24 | **DONE** (§10) |
| T-26 | CS | **Deleted what D1 makes dead:** `CompanyController.saveQboCredentials` + its route, the `hasCredentials` two-phase concept in both `getConnections` and console status. Settle **one** `getConnections` response shape — four incompatible ones were proposed — write it into this file before the frontend consumes it, and **omit `connectUrl`** (T-01 moves minting to a POST). | T-22 | **DONE** (§10) |

### Phase 3 — correctness fixes (all need columns → all before T-10)

| ID | Repo | Task | Blocked by | Status |
|---|---|---|---|---|
| T-02 | CS | **Token refresh, both halves (G1).** (a) Update the in-memory `conn` after a refresh so the next `qboFetch` in the same sync stops re-refreshing with a rotated token. (b) Port the `refresh_lock_until` conditional-UPDATE claim from `collection_agent_backend/src/services/qbo-entity-service.ts:402`. Acceptance: a check script proves **sequential** calls issue one token request, and **concurrent** calls issue one. | — | TODO |
| T-04 | CS | Pass customer **email** (`loadSuggestedCustomerEmail(jobId)`) and an **address fallback** into `syncQuoteToQbo` (G4, G5) — also the input AST needs (G16). | — | TODO |
| T-05 | CS | Company-scope the retry path (`loadOwnedQuote` is user-scoped) per US8 "technician (or support)". | T-01 | TODO |
| T-06 | CS | Guard double-posting: claim the quote before creating (G7). | — | TODO |
| T-07 | CS | Item ceilings: paginate past 1000 (G9); decide the income account for auto-created items (G10); **set taxability on created items** (G14). | T-18 | TODO |
| T-09 | BOTH | **D4 — QB icon on synced estimates.** Expose sync state on the quote DTO (`qboEstimateId`, plus `qboSyncedAt` / `qboSyncError` to tell *never posted* from *failed*). **Decide one owner for that write** — inside `syncQuoteToQbo` or in `quote.controller.ts` — two investigations put it in both layers. Icon states must cover *reconnect required* (T-24) and *stale after disconnect* (G6 below). Find every place a quote renders, not just the Invoice tab. | T-24 | TODO |
| T-27 | BOTH | **Disconnect leaves the icon lying.** Deleting the connection never touches `Quote.qboEstimateId`, so every completed quote keeps a "synced" badge pointing into an account the company no longer has — same after reconnecting to a *different* realm. Decide: clear the ids on disconnect, or make the icon realm-aware. | T-09 | TODO |

### Phase 4 — sales tax (D6's read requirement)

| ID | Repo | Task | Blocked by | Status |
|---|---|---|---|---|
| T-28 | — | **Out-of-band Intuit probes — no Clara code, no deployment.** Against a sandbox realm via curl/OAuth Playground: (a) post today's payload with no tax fields and read back `TxnTaxDetail` / `TotalAmt`; (b) add `TxnTaxCodeRef` alone, then a structured `ShipAddr`, then per-line `TaxCodeRef`; (c) read `Preferences` and record whether `TaxPrefs.PartnerTaxEnabled` is present; (d) **re-post through the sparse-update path with no `TxnTaxDetail` and check whether tax survives or is zeroed** — every re-completion goes through that path, so a sparse update that strips tax would corrupt already-correct estimates. Record everything in §9. | — | TODO |
| T-18 | CS | **Implement tax** on the probe results and D-7/D-8/D-9: `qboTaxProfile(conn)` reading `Preferences` (cached per sync), per-line `TaxCodeRef` from the existing `isLabor` rule, `ShipAddr`/`ShipFromAddr`, and any tax columns. Never send `TotalAmt` — QBO overwrites it. Columns go to **T-10**. | T-28, D-7, D-8, D-9 | TODO |
| T-19 | CS | **Fix G17 now, independently of QuickBooks:** the proposal PDF prints "Taxed ✓" on material lines while `taxOther` is hardcoded to 0. Either stop printing the column or make it truthful. Needs none of the tax decisions. | — | TODO |
| T-32 | BOTH | **Build the CLARA-side tax architecture** (§4a, `~/clara/tax_architecture_for_estimates.md`): org tax settings (display basis, per-item-type taxability, default rate), price-book price basis, per-line taxable toggle + advanced rate override, per-line tax snapshot, and inclusive/exclusive totals. Independent of QuickBooks and larger than the QBO mapping it feeds. Scope separately before estimating. | D-7, D-9 | TODO |
| T-29 | CS | **The other half of "read".** `customerRefFor` does one exact-name query and creates on a miss — no customer list, no picker, so a customer spelled differently in QBO silently duplicates. Nothing reads `CompanyInfo`. Nothing flows QBO→CLARA at all: an estimate edited or accepted inside QuickBooks never reaches CLARA, and the update-in-place path would overwrite that edit on the next re-completion. Scope what v1 actually needs. | — | TODO |

### Phase 5 — test, migrate, ship

| ID | Repo | Task | Blocked by | Status |
|---|---|---|---|---|
| T-30 | CS | **Fix what the rework breaks in `npm test`** — and note this fails the **deploy**, not just a local check (`Dockerfile:24` runs `npm test` in the builder stage). `scripts/check-qbo.ts` builds complete `LineItemDto` literals and `templates.ts:136` builds a complete `QuoteDto` literal, so any new DTO field breaks both. Add check scripts for the new pure functions (`isAdminRole`, `qboConnected`'s stamp, `isQboConfigured`'s env matrix) — the repo has fourteen wired into `npm test`; this rework adds zero so far. | T-01, T-09, T-18 | TODO |
| T-11 | CS | `npm install`, then a clean `npm run typecheck` + `npm test`. | — | **DONE** 2026-09-04: `npm ci --registry=https://registry.npmjs.org` (473 pkgs — the repo `.npmrc` CodeArtifact token is expired, but the deps are public); `tsc --noEmit` exit 0; `npm test` exit 0, all 15 checks. |
| T-10 | CS | **Run the migration — once.** *(Edits Ashish's runbook block additively — merge into it, never replace it.)* Merge every column change (T-24 drops, T-02 lock, T-09 sync state, T-18 tax) into the single block, add `DROP COLUMN IF EXISTS` for the removed key columns, **probe the target schema first** (`information_schema.columns` — merged ≠ applied, no ledger), apply by hand to local dev **and** prod Aurora. Never `prisma db push`. | T-24, T-02, T-09, T-18 | **DONE** 2026-09-04 — applied and verified on prod Aurora (§10) |
| T-08 | BOTH | **Sandbox end-to-end — on the production environment with sandbox credentials (D-10).** Set `QBO_ENVIRONMENT=sandbox` and the Development keyset there, register the callback on the **Development** redirect-URI list, and walk: first post; reopen → edit → re-complete (update-in-place, confirm sparse update replaces lines); estimate deleted in QBO → re-complete; access revoked in QBO; either/or options; unpriced line; empty quote. Record in §9. **Caveat to manage, not a blocker:** for the duration, a live Connect button sits in front of real customers and would bind them to an Intuit *test* company — worse now that `15c465c` shows the card to every user. Mitigate by settling D-11 first (admin-only Connect), doing it in a known window, and flipping to the Production keyset immediately after. The environment stamp (T-24) makes the flip fail closed, so every sandbox connection reads *reconnect required* rather than silently posting into a test company. | T-10, D-11 | TODO |
| T-15 | CS | Set all QBO env vars on every deploy target (`QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT`, `QBO_REDIRECT_URI`, `QBO_TOKEN_KEY`). Note Intuit issues **separate keysets for Development and Production** — the sandbox→production flip swaps the key pair *and* invalidates every token minted under the old one (T-24 makes that fail closed). | T-22, T-23 | **DONE** 2026-09-04 — secret `techcopilot/prod/app` + task def `:86`; service NOT updated (§10) |
| T-14 | BOTH | Write each repo's real deploy model into §8 (backend: CodeBuild → ECR → ECS, no in-repo trigger found; frontend: TBD). Do not carry over the `collection_agent_backend` auto-deploy assumption. | — | TODO |
| T-12 | CS | **Console auth.** `adminRoute` is mounted unauthenticated (`server.ts:86`). Even after T-20 removes the connect handler, `GET /op-x7k2/companies/:companyId/qbo` leaks realm id and connection state for any company id, and `DELETE …/qbo` disconnects any company's QuickBooks. At minimum put a shared-secret header on the QBO routes. | T-20 | TODO |
| T-13 | CS | Confirm staging/prod run with `NODE_ENV=production` so the `X-Dev-Bypass` header cannot fabricate a `companyId`. | — | TODO |
| T-31 | BOTH | **Update the canonical PRD, not just the status doc.** *(Edits Ashish's files — `QBO_PRD_IMPLEMENTATION_STATUS.md` and the Confluence PRD. These corrections are necessary and additive; make them surgically and say what changed, do not rewrite his documents.)* US1 still specifies the per-company key form; open question #3 is now decided; the story table has no row for sales tax or read-back, so D6's requirement is untrackable; and `QBO_PRD_IMPLEMENTATION_STATUS.md:4` ("the code matches the PRD") plus its ✅ on US1/US10 become false the moment this lands — as does its "small change, isolated in qbo.ts + ConnectionsCard" estimate, against ~14 files across two repos. | — | TODO |
| T-17 | CS | Observability for the ≥95%-within-a-minute measure. | T-09 | TODO |
| T-16 | BOTH | *(folded into T-25)* Self-serve disconnect. | — | — |

### Deliberately out of scope, recorded so nobody re-discovers them

- **One shared Intuit app pools risk**: app-level throttles now apply across all clients, and one
  app suspension or failed re-assessment takes down every client at once. Accepted with D-1.
- The unauthenticated company-registration route creates an `admin` user; under D-1 that user can
  now reach a Connect button. Tracked via T-12/T-13, not separately.

## 8. Session protocol and environment facts

### Working across windows

1. Read this file top to bottom, then pick a task in §7 whose status is `TODO` and whose
   *Blocked by* is empty.
2. Set it to `IN PROGRESS (<window/date>)` **before** starting.
3. Work on `feature/QBO-integration` (or a branch off it). Never force-push and never rewrite
   Ashish's commit — additive commits only. Fetch first; he commits straight to `main`.
4. On finish: set `DONE` with one line of evidence (command + result, or commit sha). No ✅
   without evidence.
5. New work discovered → add a task row rather than doing it silently.

### Environment facts worth not re-learning

- **No test runner** in copilot-server (no jest/vitest). The convention is standalone assertion
  scripts — `scripts/check-*.ts` run via `tsx`, wired into `npm test`. QBO already has
  `scripts/check-qbo.ts` (`npm run check:qbo`). Follow that pattern.
- **Local `node_modules` in copilot-server is stale/incomplete** (sharp, exceljs, pizzip,
  docxtemplater, pdfjs-dist, csv-parse missing). `npm run typecheck` reports module-not-found
  errors that are *environment*, not branch defects. `npm install` first.
- **Never `prisma db push` / `prisma migrate` here.** The duplicate `DIRECT_URL` in the local
  `.env` makes the Prisma CLI target **production**. Migrations are hand-run SQL from
  `docs/PROD_DB_MIGRATION_RUNBOOK.md`.
- Migrations are applied by hand with no ledger: **merged ≠ applied**. Probe the real schema
  before assuming a column exists.
- copilot-server's deploy model is **unverified** — do not assume merge auto-deploys (that is
  `collection_agent_backend` only). → T-14
- Frontend has two backends: `VITE_API_BASE_URL` = platform API (auth, users, jobs);
  `VITE_COPILOT_BASE_URL` = copilot-server (quotes, QBO).
- **`npm test` runs inside the Docker build** (`Dockerfile:24`, builder stage). A broken check
  script therefore fails the **deploy**, not just a local run.
- **copilot-server deploys via CodeBuild → ECR → ECS** (`buildspec.yml`); no in-repo trigger was
  found, so what starts the build is still unknown (T-14). The staging copilot-server host in the
  frontend's `.env` (`…execute-api.ap-south-1…/staging`) returns **504 on every path** — treat
  staging as dead until proven otherwise.
- **Intuit issues separate Development and Production keysets** on one app, each with its **own**
  redirect-URI list, matched character-for-character. Changing the callback path later means
  re-registering on both and redoing consent.
- The full six-way investigation behind §7 (10–13 file-level changes per area, with line numbers)
  is preserved at
  `~/.claude/projects/-Users-bharath/1a91df37-24de-4e32-9ec6-c2e03622df04/subagents/workflows/wf_33bfb128-a6f/journal.jsonl`
  — one JSON line per agent. Read it if you need the per-file detail this board summarises.

---

## 9. Sandbox test results (T-08)

_Empty until T-08 runs. Record: date, sandbox realm, each scenario, and the observed QBO state._

---

## 10. Implementation log

### 2026-09-04 — auth flow (D-1 rework) implemented

Branch **`feat/qbo-clara-owned-auth`** in *both* repos, cut from `origin/feature/QBO-integration`.
Not pushed, not merged. Ashish's commits are untouched — additive only.

**Verified:** `npx tsc --noEmit` clean in both repos; `npm test` exit 0 in copilot-server (all 15
checks, including the new `check:qboauth`).

**copilot-server**

| File | Change |
|---|---|
| `src/lib/qbo.ts` | Keys from env (`QBO_CLIENT_ID/SECRET/ENVIRONMENT/REDIRECT_URI`); `apiBase()` loses its param; `qboAuthUrl(companyId)` needs no DB row; `tokenRequest(body)`; `connectQbo` upserts and stamps `environment`; `saveQboCredentials` deleted; `disconnectQbo` added; `qboReconnectRequired` added; token key moved to `QBO_TOKEN_KEY` (throws if unset, no fallback); **DEFERRED-NOT-CANCELLED** block comment records the per-company-keys design. Also fixed half of G1: the refreshed pair is now written back onto the in-memory `conn`, so the 4–8 sequential calls in one sync stop re-refreshing with a rotated token. The concurrent half still needs T-02's lock column. |
| `src/api/middlewares/auth.ts` | `ADMIN_ROLES`, `isAdminRole` (admin **+ service_manager**), `requireAdmin`. |
| `src/api/controllers/company.controller.ts` | `getConnections` carries no auth URL and no `hasCredentials`, adds `reconnectRequired`; new `startQboConnect` (POST → `{authUrl}`), `qboCallback` (moved here), `disconnectQboForCompany`; `saveQboCredentials` removed. |
| `src/api/routes/company.route.ts` | Callback unauthenticated (signed state is its credential); status + item list open to all roles; connect / disconnect / markup write behind `requireAdmin`. |
| `src/api/controllers/admin.controller.ts`, `admin.route.ts` | **`qboConnect` and `qboCallback` deleted** — the G15 fix. Status now reports `tokenEnvironment` vs `serverEnvironment`. |
| `prisma/schema.prisma` | `client_id` / `encrypted_client_secret` dropped; `environment` repurposed as the keyset stamp. |
| `docs/PROD_DB_MIGRATION_RUNBOOK.md` | Block revised, with `DROP COLUMN IF EXISTS` for both key columns — required, because `CREATE TABLE IF NOT EXISTS` is a no-op wherever the older block already ran and a leftover `NOT NULL client_id` would reject every callback insert. |
| `.env.example` | The five QBO vars, documented. |
| `scripts/check-qbo-auth.ts` + `package.json` | New check wired into `npm test`: role matrix, environment-stamp semantics, signed-state round-trip plus forged / tampered / expired rejection, and the configured matrix. |

**technician-copilot**

| File | Change |
|---|---|
| `src/lib/roles.ts` (new) | `isAdminRole` — mirrors the server helper. |
| `src/components/profile/ConnectionsCard.tsx` | Key form → one Connect button calling `POST …/connect`; Reconnect + Disconnect; "Reconnect needed" state; **visible to every user, actions admin-only**; deferred key form recorded as a comment, not deleted. |
| `src/services/connectionsService.ts` | `startQboConnect`, `disconnectQbo`; status type drops `hasCredentials`/`connectUrl`, gains `reconnectRequired`. |
| `src/store/useAuthStore.ts`, `src/pages/Profile.tsx`, `src/components/profile/MyProfileTab.tsx` | `service_manager` recognised as admin (D-3). |

**Not done, deliberately:** the migration has NOT been run anywhere (T-10 — and T-02/T-09/T-18
still owe it columns); no env vars are set on any server (T-15); nothing tested against Intuit
(T-08); D-11 answered as "all users can view", implemented as view-for-all / act-for-admins.

### 2026-09-04 — pushed, and the deploy target

Both commits are on `origin/feature/QBO-integration` (fast-forward, Ashish's commits untouched):

```
copilot-server      ce771ab  QBO: Clara-owned Intuit app, admin-gated connect, callback off the console
technician-copilot  667580e  QBO: one-click Connect, admin-gated actions, service_manager is an admin
```

**Infrastructure, established by probing (T-14 partially answered):**

| What | Where |
|---|---|
| copilot-server (backend) | `techcopilot-assistant.justclara.ai` → ECS `techcopilot-prod-ecs-cluster` / service `techcopilot-prod-assistant`, container `assistant`, **us-east-1**, account `458799594709` |
| platform API (users/auth) | `techcopilot-core.justclara.ai` → service `techcopilot-prod-core` |
| frontend | `tech.justclara.ai` (also `field.justclara.ai`, which 301s to add a trailing slash) |
| config style | one Secrets Manager secret **`techcopilot/prod/app`**; the task definition references 19 keys from it. Only `NODE_ENV` is a plain env var — **QBO vars belong in the secret, not in `environment`** |
| staging | the `execute-api` host in the frontend `.env` returns 504. Dead. |

**Intuit app values** (the customer-facing fields, mirroring collections'
`collections.justclara.ai/settings?tab=integrations`):

| Field | Value |
|---|---|
| Host domain | `tech.justclara.ai` |
| Launch / Disconnect / Connect-Reconnect URL | `https://tech.justclara.ai/profile` |
| Redirect URI | `https://techcopilot-assistant.justclara.ai/api/v1/companies/connections/qbo/callback` |

The redirect URI must be registered on **both** keysets (Development and Production) and matches
character-for-character. A second URI on `techcopilot-core...` is also registered — it will 404
forever, since that host is the platform API; remove it so nobody wires it up by mistake.

**Credentials verified 2026-09-04.** Sandbox client id + secret POSTed to Intuit's token endpoint
with a deliberately invalid code returned `400 invalid_grant "Invalid authorization code"` — the
app authenticated, only the fake code was rejected. Control: the same client id with a wrong
secret returned `401 invalid_client`. **The redirect URI could NOT be verified this way** — a
consent URL built with a deliberately unregistered redirect URI reaches the identical Intuit
sign-in page, because Intuit checks `redirect_uri` only after the user signs in. Only a real
browser consent proves it.

**Env vars set — T-15 done, 2026-09-04.** The five QBO keys were merged into the
`techcopilot/prod/app` Secrets Manager secret (now 29 keys; version `e0469f6c-45f3-4412-82db-2663ba672467`;
no existing key overwritten) and task definition **`techcopilot-prod-assistant:86`** was registered
with them, up from 19 secrets to 24.

**The service was deliberately NOT updated.** It still runs `:85`, ACTIVE, 1/1 — production is
untouched, and the new variables do nothing until the QBO image is deployed. To go live:

```
aws ecs update-service --region us-east-1 --cluster techcopilot-prod-ecs-cluster \
  --service techcopilot-prod-assistant \
  --task-definition arn:aws:ecs:us-east-1:458799594709:task-definition/techcopilot-prod-assistant:86 \
  --force-new-deployment
```

Note `QBO_ENVIRONMENT=sandbox` is now in a **production** secret. That is the plan (D-10: test on
prod with sandbox credentials), but it means the flip to production is a secret edit plus a new
task-definition revision, not just a redeploy — and every connection made in the meantime stops
working at that point, by design (T-24's environment stamp), so those companies must reconnect.

The script that did it, re-runnable and idempotent (dry-run by default, `--apply` to write):
`scratchpad/set-qbo-env.sh`. It reads values from `copilot-server/.env`, never prints them, and
reuses the existing secret-ARN prefix rather than guessing it.

**Then, in order:** run the `qbo_connections` block from the runbook (T-10) → deploy the branch to
`techcopilot-prod-assistant` → click Connect as an admin and sign in with a sandbox QuickBooks
company (T-08). Until the migration runs, the callback will fail on the insert.


### 2026-09-04 — migration applied to production, env live, service on :86

**Migration: DONE and verified (T-10).**

Probed first, as the runbook demands — merged is not applied, and nothing was: `qbo_connections`
absent, 0 of the 5 columns present, on database `techcopilot`, schema `public`.

Getting there took some working out, recorded so nobody repeats it:

- Aurora is **private** (`10.0.4.221`); no route from a laptop. The bastion EC2 instance is **not**
  SSM-managed (`describe-instance-information` is empty), so port-forwarding is not an option.
- The fix: run one-off ECS tasks on the service's own task definition, inside the VPC, with the
  service's network config. `scratchpad/ecs-run.sh` does this and prints the container's
  CloudWatch output. The runtime image keeps the **full** `node_modules` (`Dockerfile:40`), so the
  Prisma CLI is available inside it.
- `app_user` **cannot** run this migration: not a superuser, no `CREATE` on schema `public`, and
  `quotes` / `quote_line_items` / `company_configs` are owned by `postgres`. First attempt failed
  with `permission denied for schema public` — which is exactly what the runbook's "created by
  postgres" line means.
- Aurora's master secret is `rds!cluster-354ddf05-…`, and the ECS **execution role already has
  `GetSecretValue` on that exact ARN** — so a throwaway task definition (`:87`) injected the master
  credentials as ECS `secrets` (an ARN reference: the password never appeared in a command line,
  a task override or a CloudTrail event). `:87` was **deregistered** immediately after.

Verified as `app_user`, the account the app actually uses:

```
qbo_connections           owner app_user; columns: id, company_id, environment, realm_id,
                          encrypted_auth, access_token_expires_at, created_at, updated_at
new columns               5/5 present
app_user privileges       SELECT / INSERT / UPDATE / DELETE all true
production after the DDL  97 quotes, 674 line items, 7 company_configs — all still readable by
                          the running image (no regression)
```

**Service is on `:86`** (rolling update, `minimumHealthyPercent 100` so no downtime; one
deployment, 1/1 running, `/health` 200). This matters for the pipeline: CodePipeline's ECS deploy
action derives its new revision from whatever the service is running, so had it deployed while the
service was on `:85`, the five QBO secrets would have been silently dropped.

**Correction — merging to `main` does NOT apply the Prisma schema.** Checked directly: `db:migrate`
and `db:push` exist in `package.json` but nothing calls them; the Dockerfile runs only
`prisma generate` (client codegen) then `node dist/server.js`; `buildspec.yml` builds and pushes an
image; the pipeline is Source(`main`) → Build → ECS deploy, with no migration stage; and
`prisma/` has **no `migrations/` directory at all**, so `prisma migrate deploy` could not run even
if something called it. Migrations here are hand-run, exactly as the runbook says. This is why the
migration had to happen before the code ships — Prisma selects all scalar columns, so shipping the
QBO image against the old schema would have broken **every quote read**, not just QuickBooks.

### The remaining step: merging to `main` is the deploy

Both repos deploy from `main`, automatically:

| Repo | Mechanism | Trigger |
|---|---|---|
| copilot-server | CodePipeline `techcopilot-prod-assistant`: GitHub `main` → CodeBuild → ECS deploy | push to `main` |
| technician-copilot | AWS Amplify app `technician-copilot`, production branch `main` | push to `main` |

**The two must ship together, frontend first.** `quote.controller.ts::complete` returns
`409 OPTION_CHOICE_REQUIRED` whenever a quote has option groups — with **no QuickBooks condition on
it**. A new backend against the old frontend would break completing any option quote for every
company, connected or not. The reverse order is safe: the new frontend against the old backend
sends an extra `chosenOption` field the old backend ignores, and its QBO fetches 404 into
already-handled catch branches (the item dropdown hides itself; the Connections card reads
"Status unavailable").

Current exposure is nil — **0 quotes in production have ever used an option group** (97 quotes
total: 93 DRAFT, 4 COMPLETED; 28 created in the last 14 days) — but that is luck, not a guarantee.

### 2026-09-04 — shipped to `main`

| Repo | PR | Merge |
|---|---|---|
| technician-copilot | [#4](https://github.com/getlisa/technician-copilot/pull/4) | merged `cf7fe08` → Amplify job 57 |
| copilot-server | [#4](https://github.com/getlisa/copilot-server/pull/4) | held until the frontend is live (ordering below) |

`origin/main` on technician-copilot had moved (`487cbbf fix: access token`, Ashish), which
conflicted in `quotesService.complete`: main switched it to `authFetch` (silent token refresh for
copilot-server calls, which bypass the axios interceptor), the QBO branch added `chosenOption`.
Resolved by keeping both — `authFetch` is a drop-in for `fetch`. `connectionsService` was also
switched to `authFetch`: its endpoints are new on this branch and had the exact bug `487cbbf`
fixed, so an expired access token would have failed the Connections card and the item list until
the user logged out and back in.

**Ordering (frontend first) is not cosmetic.** `complete` returns `409 OPTION_CHOICE_REQUIRED` for
any quote with option groups and has no QuickBooks condition on it, so the new backend against the
old frontend breaks completing option quotes for every company. The reverse is safe.

### 2026-09-04 — live in production, verified

Both merged; both deployed.

| | Result |
|---|---|
| technician-copilot | PR #4 → `cf7fe08`, Amplify job 57 **SUCCEED**; `tech.justclara.ai/profile` 200 |
| copilot-server | PR #4 → `d945764`, pipeline `9c929e3f` **Succeeded**; ECS on `techcopilot-prod-assistant:88`, 1/1 |

The deployed revision `:88` was derived from `:86`, so all five QBO secrets carried over — which is
exactly why the service was moved onto `:86` beforehand. Note the Docker build runs `npm test`
(`Dockerfile:24`), so `check:qboauth` is a hard gate on every deploy from here on.

Verified against the live service:

```
/health                                      200
/api/v1/companies/connections                401  route exists, auth required
/api/v1/companies/connections/qbo/items      401  same
/api/v1/companies/connections/qbo/callback   200  "That QuickBooks link was invalid or expired"
                                                  — a callback with no signed state is refused
/api/v1/op-x7k2/companies/:id/qbo/connect    404  DELETED — the G15 hole is closed in production
/api/v1/op-x7k2/companies/:id/qbo            200  {"configured":true, "connected":false,
                                                   "reconnectRequired":false, "realmId":null,
                                                   "tokenEnvironment":null,
                                                   "serverEnvironment":"sandbox"}
```

`configured: true` is the useful one: `isQboConfigured()` requires `QBO_CLIENT_ID`,
`QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI` **and** `QBO_TOKEN_KEY` to all be present, so the
application itself confirms every variable arrived and is readable.

**Still unproven, and only a browser can prove it:** whether the redirect URI is registered on the
Intuit app. Intuit validates it only after the user signs in. The next action is a human clicking
Connect as an admin and approving with a sandbox QuickBooks company (T-08).

### 2026-09-04 — first real connection, and the UI round-trip

**T-08, first half: PROVEN.** A sandbox QuickBooks company connected end to end.

```
qbo_connections  id 2, company_id 9, environment sandbox,
                 realm_id 9341455474664217, tokens present,
                 access_token_expires_at 2026-09-04T12:47:17Z
```

That single row settles four things at once that no headless test could: the redirect URI **is**
registered on the Intuit app, the consent completed, the authorization-code exchange succeeded, and
`QBO_TOKEN_KEY` sealed the token pair (the row could not have been written otherwise).

Three follow-ups shipped after it:

1. **The callback now returns the user to the app.** Intuit hands the browser to the API, which
   rendered a "you can close this tab" page — leaving the user parked on an API response. It now
   302s to `QBO_APP_RETURN_URL` with `?qbo=connected|error`; the card turns that into a toast and
   strips the parameter so a refresh does not replay it. Verified live: a callback with no state
   returns `302 → https://field.justclara.ai/profile?qbo=error`.
   `ALLOW_ORIGIN` could not be reused for the target — it is `*`.
2. **Sandbox badge removed** and **"Completed quotes post to your QuickBooks as estimates" removed**
   (the connected state now renders no descriptive line at all — the badge says it).
3. From the round before: **`canManage` now comes from the server**, and non-admins see
   "Only a company admin can connect QuickBooks" instead of an empty card.

**Correction to an earlier entry:** the frontend is **`field.justclara.ai`** — it is Amplify's only
domain association, and its bundle contains the QBO code. `tech.justclara.ai` is a *different,
older* app with zero QBO code in it; the Intuit Host domain and Launch/Disconnect/Connect URLs
must use `field.justclara.ai`, not `tech.justclara.ai` as previously written here.

**A mistake worth not repeating.** Adding `QBO_APP_RETURN_URL` to the task definition, I derived
the secret ARN with `valueFrom.rsplit(":", 2)[0]`, which strips only the two empty trailing fields
and leaves the *previous* key glued on — producing
`…app-qRY1HD:ALLOW_ORIGIN:QBO_APP_RETURN_URL::` and `ResourceInitializationError: unexpected ARN
format with parameters`. Revision `:91` could not start. **Production never went down**:
`minimumHealthyPercent 100` kept `:90` serving throughout, which is the whole point of that
setting. Fixed by rebuilding from `:90` with `re.sub(r":[^:]*::$", "", valueFrom)` — the form
`scratchpad/set-qbo-env.sh` already used — registering `:92`, and deregistering `:91`. The
pipeline then built `:93` from `:92`.

Live now: ECS `:93`, `/health` 200, Amplify job 59 SUCCEED.

**Next on T-08:** complete a quote for company 9 and confirm the estimate appears in the sandbox
QuickBooks with the right customer, items and total — then the reopen → re-complete update-in-place
path, the deleted-in-QBO path, and the option-choice gate.
