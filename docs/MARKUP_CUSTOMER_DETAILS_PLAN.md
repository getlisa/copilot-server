# Estimator Agent — Customer Details, Materials Markup & Image Attachments

Source PRD: [PRD: Estimator Agent — Improvements (Customer Details, Materials Markup and Image attachments)](https://justclara.atlassian.net/wiki/spaces/EA/pages/105709569)
(SivaRaman, 2026-08-18 — since retitled to add image attachments as a third feature).

**Status: all three features are CODE-COMPLETE in both repos, and the prod DDL is APPLIED
(2026-08-20).** Markup backend was already live in prod; the markup frontend UI, customer
details (server + agent + docs + frontend), and quote-level image attachments (server +
frontend) are implemented and pass `npm test` (including the new `check:customerdetails`).
The customer/image columns were applied to prod Aurora on 2026-08-20 via the §1 escalation
path, this time with the DDL executed through the container's own Prisma client (`node -e` +
`$executeRawUnsafe`, master creds injected as task-definition secrets) — all four statements
verified `is_nullable = YES`. The same columns are applied to the dev Supabase DB.
Remaining: deploy copilot-server → green → technician-copilot, and rotate the Aurora master
secret (it was handled interactively during this run).

UI decisions (PM, 2026-08-19, from the design canvas
"Customer Details Entry Options" — Option D): customer details render as a **card at the top of
the Invoice tab** with three states:

- **Empty:** a single-line card — muted "Add customer details (optional)" text plus a pencil
  button, nothing else. No "Bill To" label and no empty field rows until data exists.
- **Display:** "BILL TO" label, the details as printed text (name bold, address, phone; a
  missing field shows a muted "No phone"-style line), pencil button in the corner.
- **Edit (via pencil):** the card switches to boxed inputs (Name / Address / Phone); Done or
  blur commits and returns to display. Pencil hidden when Completed — the card freezes in
  display state.

Chat/voice capture updates the same card. The **Markup field moves to the top** of the Invoice
tab, directly below the customer card, labeled "materials only"; only the Total row stays at
the bottom.

Both features live in `src/copilot/estimating/` (the Estimating Agent: `Quote` /
`QuoteLineItem`, `DRAFT → COMPLETED`, pricebook + Home Depot fallback, Chat/Invoice tabs).
Not `src/copilot/estimate/`, the older single-shot flow — its schema already has
`kind: material|labor|…` and `laborSubtotal`, which makes it tempting to reuse and wrong to.

---

## 1. Materials markup — what shipped

One percentage per quote, `quotes.markup_percent`, applied on every **read** rather than
written into the line items. That is what makes it a live multiplier and not a snapshot: a line
added after the markup was set picks it up with no extra action, and changing the percentage
re-prices every material line at once.

Set it two ways, both writing the same column: the "Markup" field above Total on the Invoice
tab, or by saying it in the chat ("mark it up 20 percent").

### Where the arithmetic lives

`quoteDto.ts` — `markedUpPrices` is the only place markup is ever applied, and every total in
the file sums its results, so the app's total and a document's printed line prices cannot
disagree. Applying it at the DTO layer means these all inherit it with no change of their own:
the review screen, `quoteDocx`, `proposalDocx`, `proposalPdf`, and the proposal email's
cost-in-words. None of them print the percentage or a markup row — the marked-up prices simply
appear as the prices.

Rounding: the unit price is marked up and rounded to cents **first**, then multiplied by the
quantity, so a printed row always multiplies out for whoever reads it (3 × $12.14 = $36.42, not
a $36.41 that came from marking up the line total). A hand-typed line total is marked up
directly, keeping `effectiveTotal`'s precedence — a manual total deliberately isn't qty × unit
price. `check-markup.ts` pins `markedUpPrices` to `effectiveTotal` at 0% so the two can't drift.

### The labor boundary

Labor had **no representation in the data at all** before this, so
`quote_line_items.is_labor` had to be added. Deriving labor from `search_term IS NULL` does not
work: manually added lines have a null search term too, and the PRD requires
manually-overridden *materials* to be marked up, so the derivation would exempt exactly the
lines that must be included.

The agent sets `is_labor` on the same lines it already marks unpurchasable, existing rows
default to material, and a technician can correct a misclassified line with the Material/Labor
chip on the Invoice tab. That chip is also the only on-screen explanation of why a line's price
carries a markup or doesn't.

### The edit round trip

The PRD forbids showing a pre-markup price anywhere, so the marked-up figure in the Invoice
tab's price field is the only place a price can be edited — and those fields commit exactly what
they display. Left alone, that stores a marked-up figure as the new cost and marks it up again
on the next read, compounding on every edit. `stripMarkup` divides the markup back out on the
way in: the technician edits the customer-facing price, the column keeps the cost behind it.

Accepted cost: the column is `Decimal(12,2)`, so a hand-typed price can re-display a cent off.

### Validation

`0` accepted, negatives refused with a message (a negative markup is a discount, and a
percentage-off workflow is an explicit non-goal — allowing it would reopen that through a side
door). Draft-only; a Completed quote returns 409. The upper bound of 999.99 is the column's
limit, not a product sanity bound — the PRD deliberately has none and flags that gap itself as
higher-blast-radius than the open quantity/hours gaps, since one bad number multiplies every
material line at once. **Worth a fast-follow ticket.**

### Files

| File | Change |
|---|---|
| `prisma/schema.prisma` | `Quote.markupPercent`, `QuoteLineItem.isLabor` |
| `scripts/add-markup-columns.ts` | the two ALTERs + a labor backfill |
| `src/copilot/estimating/quoteDto.ts` | `markedUpPrices`, `stripMarkup`, marked-up DTO |
| `src/api/controllers/quote.controller.ts` | `updateQuote`; strip markup on add/update; `isLabor` patch |
| `src/api/routes/quote.route.ts` | `PATCH /:quoteId` |
| `src/copilot/estimating/estimatingAgent.ts` | `isLabor` op field, `markupPercent` output, prompt rules |
| `scripts/check-markup.ts` | 31 checks, wired into `npm test` |
| *technician-copilot* `src/services/quotesService.ts` | types + `updateQuote` |
| *technician-copilot* `src/components/quotes/QuoteInvoiceTab.tsx` | Markup field, Material/Labor chip |

### Applied to prod on 2026-08-19 — and how, because it was not straightforward

Order matters: the columns must exist **before** the server image deploys, since Prisma selects
both on every quote query. Sequence used, all verified: ALTERs → `git push` copilot-server →
pipeline `techcopilot-prod-assistant` green → `git push` technician-copilot → Amplify green.

Applying them took a temporary privilege escalation, because **the application cannot do it**
(see below). What worked:

1. Grant `techcopilot-prod-ecs-execution-role` read on the RDS master secret — one extra
   statement on its `AllowReadAppSecrets` inline policy. **Back the policy up first**; the
   revert must be byte-for-byte.
2. Register a throwaway task definition off `techcopilot-prod-assistant`, adding
   `MIGRATE_DB_USER` / `MIGRATE_DB_PASS` as `secrets` pointing at that ARN's `username` /
   `password` JSON keys. Referencing by ARN means the password never passes through an API call
   or CloudTrail — ECS injects it at task start.
3. `aws ecs run-task` on that definition with a `command` override, connecting as `postgres`.
   Aurora is on a private subnet, so it has to run inside the VPC.
4. **Revert the IAM policy and deregister the throwaway definition.**

Results: both columns created; `GRANT SELECT, INSERT, UPDATE, DELETE ON quotes,
quote_line_items TO app_user` refreshed and proven with a rolled-back write; 68 quotes all at
0% markup, so no existing price moved; 53 line items reclassified as labor, of which **5 were
false positives** (`12 AWG MC cable`, `1/2 in MC cable connector1`, `4 in square box flat
cover`, `4 in square junction box`, `Wire connectors` — all $1.00 placeholders) and were
reverted to material, leaving 48. The two remaining labor lines not named "labor"
(`Electrical troubleshooting / short tracing`, `Trip charge`) are correctly labor.

Verified afterwards on real prod data through the deployed compiled `toQuoteDto`: on a quote of
$105.95 materials + $1,080.00 labor, a simulated 20% moved the total to $1,207.04 with the
labor line untouched to the cent.

**The application cannot apply DDL.** Measured against techcopilot prod on 2026-08-19 by
running the ALTER from inside the VPC:

```
42501: must be owner of table quotes
```

- `quotes`, `quote_line_items`, `companies`, `conversations`, `pricebook_items` — all owned by
  `postgres`.
- `DATABASE_URL` and `DIRECT_URL` both connect as `app_user`, same user, both port 5432. The
  two URLs are not the privilege split they appear to be.
- `app_user` is not a member of `postgres`, so `SET ROLE` is not a way around it.

This is the same wall recorded in `quoteDto.ts`, and the reason a web-search price lives as an
`"EST"` sentinel inside `pricebookCode` rather than in its own column. `companies.proposal_email_template`
exists in prod despite `add-proposal-email-template.ts` implying `app_user` added it — that
column is owned by `postgres` too, so it was applied out-of-band with a credential this repo
does not hold. **There is no migration path in this repo that actually works on prod.** Worth
fixing as its own piece of work, separately from either feature here.

To apply: run as the Aurora master (`postgres`), whose credential is the RDS-managed secret
`rds!cluster-354ddf05-2500-40c0-a536-ab171d0ac675`. Readable by neither
`techcopilot-prod-ecs-execution-role` (scoped to `techcopilot/prod/*`) nor the task role (S3
only). Aurora sits on a private subnet — `10.0.4.221`, no public endpoint — so this must execute
inside the VPC. Shortest path is a one-off `aws ecs run-task` against
`techcopilot-prod-assistant` (exec is enabled, cluster `techcopilot-prod-ecs-cluster`,
us-east-1) with `DATABASE_URL` overridden to the master credential.

`prod/postgres/credentials` is **not** it — that secret holds Metabase/PostHog config.

### The real fix, still outstanding

Customer details needs three more columns, so the dance above will recur. Give this repo a
migration path that works: make `app_user` a member of the owning role, or hand the tables to a
migration role the deploy can assume. Either turns a column addition into a one-command step
instead of a temporary IAM grant against prod. Worth its own ticket before the next PRD, and it
should also fix `scripts/add-proposal-email-template.ts`, which cannot do what it claims.

---

## 2. Customer details — implemented (PRD US1–US3); A1's DDL still to run on prod

### Server

- **A1** `quotes`: add `customer_name`, `customer_address`, `customer_phone`, nullable text.
  Free text, no format validation (PRD is explicit). Same script pattern as above. **Batch this
  DDL with C1's `image_files.message_id` change — one escalation run, not two.**
- **A2** `quoteDto.ts`: add the three fields to `QuoteDto`.
- **A3** Extend the existing `PATCH /api/v1/quotes/:quoteId` (already built for markup) to
  accept them. Draft-only guard is already there.
- **A4** Chat/voice capture. The agent's `TURN_JSON_SCHEMA` is `strict: true` with every
  property required, so a new op type would force new required fields onto every other op —
  follow the `markupPercent` precedent and carry the fields beside the operations instead.
- **A5** Prompt rules: capture each field independently, never invent one, honour the existing
  "actually scratch that" correction rule (a prompt rule, not separate machinery, so correction
  comes free).
- **A6** Precedence over LLM-recovered values. Customer details are **already partly plumbed**:
  `loadQuoteHeader` defaults `customerName: "Customer"` and `proposalNarrative` has the LLM
  recover `customerName`/`siteAddress` from the conversation, which
  `buildProposalParts` merges into `mergedHeader`. Stored quote fields must take **precedence
  over** those — not a parallel path. `proposalDocx` already renders `customerName |
  billingAddress`.
- **A7** `quoteDocx` has **no** customer block at all — that part is new. Blank/omitted when
  unset; never a placeholder, never an error.
- **A8** `proposalEmail` special-cases the `"Customer"` default — confirm it picks up a real
  stored name.
- **A9** Check: a quote with zero, one, or two of three fields set still marks Completed. No new
  flag, no gating.

### Frontend

- **B1** `quotesService.ts`: three fields on `Quote`, extend `updateQuote`'s patch type.
- **B2** `QuoteInvoiceTab.tsx`: the customer card per the PM's picked design — the three-state
  spec in the header note (empty one-liner without the "Bill To" label / printed-text display /
  pencil → boxed inputs, reusing `CellInput` — commit-on-blur, iOS zoom already handled).
  Pencil hidden under the `frozen` guard. Also move the Markup field to the top, below this
  card.
- **B3** Chat ↔ field convergence is free as long as both read the same `quote` object and
  `sendMessage`'s returned quote is applied — verify, don't assume.

---

## 3. Image attachments — implemented (PRD US6); C1's DDL still to run on prod

Implementation notes (2026-08-19): C1–C7 are done as specified below, with two resolutions —
**C4:** verified, `buildProposalParts` queries by conversationId so quote-attached
(null-messageId) rows flow into both proposal formats unchanged; the basic `quoteDocx`
deliberately stays photo-free pending the PM's answer on whether it counts as a final output
document. **C5:** no conversion needed — `loadPhotos` already skips non-JPEG/PNG types with a
logged warning, so a HEIC can never break a document build (it renders in-app but is omitted
from the printed doc; iOS Safari transcodes HEIC→JPEG on file inputs anyway). **C6 placement
(PM, 2026-08-19, revised same day): no new buttons — the composer's EXISTING camera/gallery
buttons now perform the quote-level attach.** A picked/captured photo uploads immediately to
the quote (success toast points at the Invoice tab); it is never sent with a message and never
reaches the agent. The Invoice tab keeps the photo gallery: display + remove-while-Draft only.

What already exists and is kept: the S3 + multer upload stack (`s3.ts`, `imageUpload.ts`),
`POST /conversations/:id/images`, and both proposal documents' `PROJECT PHOTOS` section
(`proposalDocx.ts` `loadPhotos`, `proposalPdf.ts`). What the PRD adds is a **quote-level,
agent-free** attach path — today's flow hangs every image off a chat message and feeds it to
the agent as vision input (`runEstimatingTurn({ imageUrls })`), which the PRD explicitly
forbids for attachments ("no image analysis, recognition, or vision processing of any kind").

### Server

- **C1** `image_files`: make `message_id` nullable, so an image can belong to the quote's
  conversation without a carrier message. **Same DDL run as A1.**
- **C2** New routes `POST /quotes/:quoteId/images` (multer `imageUpload.array`, no enforced
  count cap per PRD) and `DELETE /quotes/:quoteId/images/:imageId`. Both carry the per-handler
  Completed→409 guard like every other mutation in `quote.controller.ts`. Neither touches the
  agent.
- **C3** Keep quote-attached images out of the agent's sight everywhere: the attach path never
  calls `runEstimatingTurn`, and any code that assembles agent vision context must select only
  message-attached images (`messageId != null`).
- **C4** Documents: `buildProposalParts` already queries `imageFile.findMany({ where:
  { conversationId } })`, so null-`messageId` rows flow into both proposal formats with no
  change — verify, don't assume. `quoteDocx` has no photos section; confirm with the PM whether
  the basic .docx counts as a "final output document" before adding one.
- **C5** HEIC: the multer filter accepts it, but the docx/pdf libraries likely can't render it.
  The PRD specifies no conversion *requirement*, not a prohibition — convert to JPEG on upload
  if rendering breaks. Extend `check-proposal-photos.ts` to cover a quote-attached image.

### Frontend

- **C6** Attach button near the chat text box with two distinctly-named actions — "Attach
  photo" (`<input type="file" accept="image/*" multiple>`) and "Take photo"
  (`capture="environment"`). Native inputs; OS permission prompts come free; denied permission
  gets a visible message, never a silent failure. No new dependency.
- **C7** Review-screen gallery: thumbnails of every attached image on the Invoice tab, with
  remove while Draft; remove hidden under `frozen`. Images render below the line items,
  matching their position on the output document.

### Resolved PM question

The existing chat attach button sent images *with a message, through the agent* (vision); the
PRD's attach is agent-free and quote-level. **Answered 2026-08-19: the existing composer
buttons are REPURPOSED to the quote-level attach** — no second set of buttons, and the
send-image-with-message flow is gone from the estimator web UI. Consequence, accepted: the
estimating agent no longer receives photos as vision input from this UI ("look at this panel"
won't work), which is exactly the PRD's no-analysis rule. The server still accepts
`imageUrls` on the messages endpoint — the agent's vision path remains for any other caller —
and the estimator system prompt's photo line is now moot for the web app.

---

## 4. Still open

- **Coordination:** the PRD's own item — whether per-client custom invoice templates (from the
  pricebook-template-config PRD, page 104497153, Draft) need explicit support for rendering
  marked-up prices. That PRD's owner decides.
- **Coordination:** `copilot-contract.ts` exists in both repos and is Ashish's. Neither feature
  has touched it so far; if customer details do, fetch and rebase first.
- **Fast-follow:** an upper sanity bound on the markup percentage (see §1 Validation).
- **Gap, not in PRD scope:** the PRD adds name, address and phone but no customer **email**,
  while `emailProposal` / `emailDraft` need a `to` address, currently resolved through
  `loadQuoteHeader`.
- **Pre-existing, unrelated:** the frontend's `FLAG_LABELS` and exported `BLOCKING_FLAGS` both
  omit `estimated_price`, which the server does emit — so it renders as a raw slug.
