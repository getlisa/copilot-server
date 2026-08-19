# Estimator Agent — Customer Details & Materials Markup

Source PRD: [PRD: Estimator Agent — Customer Details & Materials Markup](https://justclara.atlassian.net/wiki/spaces/EA/pages/105709569/PRD+Estimator+Agent+Customer+Details+Materials+Markup)
(SivaRaman, 2026-08-18).

**Materials markup: implemented.** **Customer details: not started** — task list in §3.

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

### Deploy order — mandatory

`scripts/add-markup-columns.ts` must run **before** the server image deploys. Prisma selects
both columns on every quote query, so deploying first breaks the entire quotes API. The ALTERs
are additive with defaults and idempotent (`IF NOT EXISTS`), so they are safe against a live
database and safe to run twice.

```
npx tsx scripts/add-markup-columns.ts
```

This follows `scripts/add-proposal-email-template.ts`: DDL through `$executeRawUnsafe` on
`DATABASE_URL`, because `prisma migrate` / `db push` read `DIRECT_URL`, which the duplicated
`.env` entry points at **prod**. (This also settles the old worry recorded in `quoteDto.ts`
about `app_user` not being able to `ALTER` — `companies.proposal_email_template` was added this
way, so the path works.)

---

## 2. Customer details — not started (PRD US1–US3)

### Server

- **A1** `quotes`: add `customer_name`, `customer_address`, `customer_phone`, nullable text.
  Free text, no format validation (PRD is explicit). Same script pattern as above.
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
- **B2** `QuoteInvoiceTab.tsx`: three dedicated fields. Reuse `CellInput` (commit-on-blur, iOS
  zoom already handled) and the `frozen` guard.
- **B3** Chat ↔ field convergence is free as long as both read the same `quote` object and
  `sendMessage`'s returned quote is applied — verify, don't assume.

---

## 3. Still open

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
