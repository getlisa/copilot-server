# QBO Integration — PRD v5 implementation status

Developer-facing map of the QuickBooks Integration PRD (Draft v5, 2026-09-03) against this
codebase. **As of 2026-09-03 the code matches the PRD** — the earlier pre-review build was
reworked (trigger, credentials, items, option handling, update-in-place, default markup).

- PRD (canonical): https://justclara.atlassian.net/wiki/spaces/EA/pages/115572739/QuickBooks+Integration+PRD
- Nothing is deployed. The DB migration has **not** been applied anywhere (see
  `PROD_DB_MIGRATION_RUNBOOK.md`, "QuickBooks Online estimate posting").

## Summary by user story

| Story | Requirement | Status |
|---|---|---|
| US1 | Connect from settings — per-company app-key form → OAuth | ✅ Done |
| US2 | Post when the quote is marked **Completed** (never on email) | ✅ Done |
| US3 | Numbers match; option choice confirmed before posting | ✅ Done (see note on "the chat asks") |
| US4 | Exact-name match reuses the QBO customer, else create | ✅ Done |
| US5 | Real QBO items: list fetch, per-line dropdown, auto-create | ✅ Done |
| US6 | Reopen → re-complete updates the same estimate in place | ✅ Done |
| US7 | Company default markup setting | ✅ Done |
| US8 | Manual retry endpoint (UI button = fast-follow) | ✅ Endpoint done; button deferred per PRD |
| US9 | ZenTrades placeholder row | ✅ Done |
| US10 | Internal console status/disconnect | ✅ Done |

## Where each piece lives

Server = `copilot-server`, frontend = `technician-copilot`.

- **Core module** — `src/lib/qbo.ts`: per-company app keys (two-phase `qbo_connections` row:
  keys first, tokens after consent; `qboConnected()` = tokens present), AES-256-GCM at rest,
  OAuth with signed 15-min state, sandbox/production per connection, item list + per-line
  item resolution (`itemRefResolver`: stored pick → exact name match → create), estimate
  mapping (`qboEstimateLines`: chosen option priced, other options text notes), and
  `syncQuoteToQbo` (create, or update-in-place via SyncToken; not-found → fresh create +
  re-link; any other error propagates so a transient failure can't duplicate).
- **Trigger** — `quote.controller.ts::complete`: option gate (409 `OPTION_CHOICE_REQUIRED` +
  options until body carries `chosenOption`), then background post via
  `postToQboInBackground`. `reopen` clears `chosenOptionGroup` (re-ask) but keeps
  `qboEstimateId` (that's what makes re-completion an update). `emailProposal` has **no** QBO
  side effect. `create` stamps `company_configs.default_markup_percent` as the new quote's
  starting markup. `updateItem` accepts `qboItemId`/`qboItemName`.
- **Retry** — `POST /api/v1/quotes/:quoteId/qbo` (completed quotes only; 409 when not
  connected). No UI button yet — the PRD leaves the visible indicator as an open question.
- **Self-serve endpoints** — `company.controller.ts`: `GET /companies/connections`,
  `PUT /companies/connections/qbo` (save keys; clears tokens → re-consent),
  `GET /companies/connections/qbo/items`, `GET/PUT /companies/markup`.
- **Console** — `admin.controller.ts`: status / connect (409 until the company's keys exist)
  / callback / disconnect (removes keys + tokens).
- **Frontend** — `ConnectionsCard.tsx` (key form → "Save & sign in" → consent tab; focus
  refetch flips the badge; Edit keys / Reconnect), `ConfigurationsTab.tsx`
  (`DefaultMarkupCard`), `QuoteInvoiceTab.tsx` (completion option picker fed by the 409;
  per-line `QboItemSelect` whose "Auto" option names the exact match or the item that will be
  created; hidden entirely when QBO isn't connected).
- **Schema** — `QboConnection` (two-phase), `Quote.qboEstimateId` + `Quote.chosenOptionGroup`,
  `QuoteLineItem.qboItemId/qboItemName`, `company_configs.default_markup_percent`. SQL in the
  runbook's pending block matches.
- **Checks** — `npm run check:qbo` pins the line mapping (chosen-option pricing, pending
  lines, per-line item refs, auto item naming); `npm run typecheck` on both projects.

## Deliberate interpretations & ceilings

- **"The chat asks" (US3)** is implemented as a completion-time picker in the Invoice tab —
  the same clarify-before-posting guarantee, deterministic rather than routed through the
  agent. Move it into an agent question card later if product wants it conversational.
- Item list is one page of 1000 active items (`qboItems`) — paginate when a client exceeds it.
- No admin-role check on the self-serve settings endpoints — matches the existing
  proposal-email-template pattern (UI gates admin; server auths the company only).
- Deferred by the PRD's own open questions: retry button / "in QuickBooks" indicator on the
  quote screen, and in-app disconnect (console-only today).

## Deployment prerequisites

1. Run the QBO SQL block in `docs/PROD_DB_MIGRATION_RUNBOOK.md` on prod Aurora **and** the
   local dev DB by hand, BEFORE deploying. Never `prisma db push` — the duplicate
   `DIRECT_URL` in local `.env` makes the Prisma CLI target prod.
2. Set `QBO_REDIRECT_URI` in the server env — the only server-level QBO setting now
   (`{PUBLIC_URL}/api/v1/op-x7k2/qbo/callback`, registered on each client's Intuit app).
3. Open PRD question to settle: client-owned Intuit app keys (as built) vs one Clara-owned
   app. If review lands on Clara-owned, the key form collapses to a launch button and keys
   move back to env — small change, isolated in `qbo.ts` + `ConnectionsCard`.
4. MOSS Electric: company row via `/company-registration`; their proposal PDFs for the
   (QBO-unrelated) proposal-template import.

## Standing notes

- The admin console (`/api/v1/op-x7k2`) is unauthenticated by owner decision; the PRD flags
  console auth for prioritization now that it manages QBO connections.
- Rotating `JWT_ACCESS_SECRET` orphans sealed app secrets/tokens — companies re-enter keys
  and reconnect (documented in `qbo.ts`; add a dedicated key if rotation becomes routine).
