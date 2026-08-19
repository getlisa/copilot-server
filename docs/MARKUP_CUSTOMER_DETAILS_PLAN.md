# Estimator Agent — Customer Details & Materials Markup: implementation map

Investigation only — nothing implemented. Source PRD:
[PRD: Estimator Agent — Customer Details & Materials Markup](https://justclara.atlassian.net/wiki/spaces/EA/pages/105709569/PRD+Estimator+Agent+Customer+Details+Materials+Markup)
(Status: Draft, SivaRaman, 2026-08-18).

Repos: `copilot-server` (this one) and `technician-copilot`.

---

## 0. Which system this touches

`copilot-server` contains **two** estimate implementations. This PRD is about
`src/copilot/estimating/` only — the Estimating Agent: `Quote` / `QuoteLineItem` Prisma
models, `DRAFT → COMPLETED` lifecycle, pricebook + Home Depot fallback, Chat/Invoice tabs.

It is **not** `src/copilot/estimate/`, the older single-shot flow whose
`estimateQuoteSchema.ts` already has `kind: material|service|labor|rental|permit|other`
plus `materialsServicesSubtotal` / `laborSubtotal` / `taxOther`. That schema is tempting to
reuse but it is a different feature with a different output path (PDF, not DOCX).

---

## 1. How markup should work

### The lever: apply it at the DTO layer, never in stored rows

`src/copilot/estimating/quoteDto.ts` is the single serialization funnel. Applying markup
there satisfies the PRD's "live multiplier, never a snapshot" requirement for free, and
these consumers inherit it with no change of their own:

| Consumer | Path | Inherits? |
|---|---|---|
| Review screen / Invoice tab | `toQuoteDto` → REST | yes |
| Basic Word export | `quoteDocx.ts` takes `QuoteDto` | yes |
| Branded bid proposal | `proposalDocx.ts` takes `total` + `optionTotals` from the DTO | yes |
| Proposal email + cost-in-words | `proposalEmail.ts` / `amountInWords(input.total)` | yes |

Paths that do **not** inherit automatically — each needs the markup passed explicitly:

- `quote.controller.ts:494` — `addItem` / `priceItem` return a bare `toLineItemDto(item, …)`
  outside `toQuoteDto`. Missed here, a newly added line shows its un-marked-up price until
  the next full refetch.
- `toQuoteDto`'s `optionTotals[].total` and `.combinedTotal` (`quoteDto.ts:197-206`) —
  option groups are summed separately from `baseTotal`, so markup must be applied to each.

### Storage

New column on `quotes`: `markup_percent numeric(5,2) not null default 0`. Per-quote, no
client-level default (PRD is explicit that markup has no config surface, unlike pricebook /
template / labor rate).

### The math — one rule, not a menu

```ts
const withMarkup = (v: number, pct: number) => Math.round(v * (1 + pct / 100) * 100) / 100;

// material line:
displayedUnitPrice = unitPrice == null ? null : withMarkup(unitPrice, pct)
displayedTotal     = item.totalPrice != null            // manual total wins, as today
                      ? withMarkup(Number(item.totalPrice), pct)
                      : round2(qty * displayedUnitPrice)
```

Mark up the **unit price first, round to cents, then multiply by quantity**. The alternative
— marking up the base line total — drifts by a cent or two from `qty × displayed unit price`,
and the Invoice tab renders qty, unit price, and total side by side (`QuoteInvoiceTab.tsx:231-270`),
so a row that visibly fails to multiply out reads as a bug to the technician. Self-consistent
display beats exactness against the base.

Labor lines pass through untouched: no markup, `rate × hours` only.

### The blocker: there is no material/labor discriminator

`QuoteLineItem` has no `kind` column, and labor today is not modelled at all — it is just a
line the agent emitted with a technician-stated `unitPrice` and `searchTerm: null`
(`estimatingAgent.ts:57,178-181`).

**Deriving labor from `searchTerm == null` does not work.** Manually added lines have null
`searchTerm` too, and the PRD explicitly requires manually-overridden *materials* to receive
markup. The derivation would silently exempt exactly the lines the PRD says to mark up. Same
for `manuallyEdited` — that flag means "price differs from pricebook", not "is labor".

So a real discriminator is required: `kind` (`MATERIAL` | `LABOR`) on `quote_line_items`,
emitted by the agent and defaulted to `MATERIAL` for existing rows.

That collides with scope: **PRD: Estimator Agent — Labor Charges** (page 105021441, also
Draft) owns labor modelling — named client labor types, configured rates, its own config
schema, re-pricing open Drafts. Two options:

- **Ship markup with a minimal `kind` discriminator now.** Markup does not have to wait on
  labor config; it only needs to know which lines are labor. Labor Charges later builds its
  rate/type schema on top of the same column. Recommended — it unblocks markup and the
  column is what Labor Charges needs anyway.
- **Sequence markup after Labor Charges.** Cleaner ownership, but markup then blocks on a
  much bigger unstarted PRD.

Either way the boundary needs a test, per the PRD ("stated as an explicit, tested boundary").

### The blocker: DDL ownership

There is **no `prisma/migrations/` directory** — only `schema.prisma`, with `db:push` /
`db:migrate` in `package.json`. And `quoteDto.ts:106-114` documents that a previous column
addition was *abandoned* for this reason:

> It lives in `pricebookCode` rather than its own column because adding one requires
> ownership of the table and the application connects as `app_user`, which Postgres will not
> let alter a table owned by `postgres`.

That is why web-search prices use an `"EST"` sentinel instead of a column. Both features here
need new columns (4 on `quotes`, 1 on `quote_line_items`), so this must be settled before
either starts. I could not verify it from here — no `.env` in the repo, only `.env.example`.

Check it directly:

```sql
select current_user;
select tablename, tableowner from pg_tables where tablename in ('quotes','quote_line_items');
```

If `app_user` is still not the owner, the options are: get the DDL hand-applied by whoever
holds `postgres` (appears to be the existing process), `alter table … owner to app_user`, or
fall back to the sentinel-style workaround — `Conversation.metadata` is already `Json?` and
is the only no-DDL place these five values could live. That fallback is worse and should be
a last resort, not a plan.

---

## 2. Task list

Tags: **[DDL]** blocked on the ownership question · **[DEC]** needs a decision first ·
**[COORD]** cross-repo / another owner.

### A. Customer details — server (PRD US1–US3)

- **A1 [DDL]** `quotes`: add `customer_name`, `customer_address`, `customer_phone`, all
  nullable text. Free text, no format validation (PRD is explicit).
- **A2** `quoteDto.ts`: add the three fields to `QuoteDto`.
- **A3** New `PATCH /api/v1/quotes/:quoteId` for quote-level fields (customer + markup).
  Route in `quote.route.ts`, handler in `quote.controller.ts`. Draft-only — reject on
  `COMPLETED` the way the frozen-quote paths already do.
- **A4 [DEC]** Chat/voice capture. The agent's `TURN_JSON_SCHEMA` is
  `strict: true` + `additionalProperties: false` with **every** property `required`
  (`estimatingAgent.ts:78-150`), so a new op type would force new required fields onto every
  op object. Cleaner: add a sibling `quoteFields` object to `AgentOutput`
  (`{customerName, customerAddress, customerPhone, markupPercent}`, all nullable) rather
  than extending the op union.
- **A5** Persist `quoteFields` in the turn handler (`sendMessage` path).
- **A6** Prompt rules: capture each field independently, never invent one, honour the
  existing "actually scratch that" correction rule (`estimatingAgent.ts:162` — a prompt rule,
  not separate machinery, so correction comes free).
- **A7** Precedence over LLM-recovered values. Customer details are **already partly
  plumbed**: `loadQuoteHeader` defaults `customerName: "Customer"`
  (`estimate/pdf/quoteHeader.ts:27`) and `proposalNarrative.ts` has the LLM recover
  `customerName` / `siteAddress` from the conversation. Stored quote fields must **take
  precedence over** those — this is not a parallel path. `proposalDocx.ts:178` already
  renders `customerName | billingAddress`.
- **A8** `quoteDocx.ts` has **no** customer block at all — that part is new. Blank/omitted
  when unset; never a placeholder, never an error.
- **A9** `proposalEmail.ts:43` special-cases the `"Customer"` default — confirm it picks up a
  real stored name.
- **A10** Test: a quote with zero, one, or two of three fields set still marks Completed. No
  new flag, no gating.

### B. Customer details — frontend

- **B1** `quotesService.ts`: add the three fields to `Quote`, add an `updateQuote` method for
  the new PATCH.
- **B2** `QuoteInvoiceTab.tsx`: three dedicated fields. Reuse the existing `CellInput`
  (commit-on-blur, iOS zoom handling already solved) and the `frozen` guard.
- **B3** Chat ↔ field convergence is free as long as both read the same `quote` object and
  `sendMessage`'s returned quote is applied — verify, don't assume.

### C. Materials markup — server (PRD US4–US5)

- **C1 [DEC]** Material/labor discriminator — see §1. Blocks C3 and everything downstream.
- **C2 [DDL]** `quotes.markup_percent numeric(5,2) not null default 0`.
- **C3** Markup math in `quoteDto.ts`: `toLineItemDto` (unit + total), `toQuoteDto`
  (`baseTotal`, `optionTotals[].total`, `.combinedTotal`).
- **C4** `quote.controller.ts:494` — pass markup into the bare `toLineItemDto`.
- **C5** Validation on the PATCH: `>= 0`, reject negative with 400, Draft-only. PRD accepts
  0% explicitly and deliberately sets **no** upper bound — it flags that gap itself as
  higher-blast-radius than the open quantity/hours gaps, since one bad number multiplies
  every material line at once. Worth a fast-follow ticket even though it is out of v1.
- **C6** Agent capture of `markupPercent` via the same `quoteFields` object as A4.
- **C7** Tests, as `scripts/check-markup.ts` in the existing `npm test` pattern (this repo
  uses `tsx` check scripts, not a test framework): labor untouched; pricebook, Home Depot,
  and manually-overridden material lines all marked up; a line added *after* markup is set
  gets it with no extra action; changing the percentage re-reflects on every line; option
  totals marked up; 0% accepted; negative rejected; frozen quote rejects the change.

### D. Materials markup — frontend

- **D1** `quotesService.ts`: `markupPercent` on `Quote`.
- **D2** `QuoteInvoiceTab.tsx`: a field labelled "Markup Percentage".
- **D3 [DEC]** **Double-markup on edit — the single biggest correctness risk.** The Invoice
  tab's unit-price and total fields are editable and commit their displayed value straight
  back via `updateItem` (`QuoteInvoiceTab.tsx:246-269`). With markup live, the field shows the
  *marked-up* price, so committing it stores the marked-up value as the new base — and markup
  is applied again on top. Every edit compounds. See §3 Q2 for the fork.

### E. Cross-repo & coordination

- **E1 [COORD]** `copilot-contract.ts` exists in **both** repos and is Ashish's contract. He
  commits straight to main. Fetch and rebase first; never overwrite it.
- **E2 [COORD]** The PRD's own open item: whether per-client custom invoice templates (from
  the pricebook-template-config PRD, page 104497153, also Draft) need explicit support for
  rendering marked-up prices. That PRD's owner decides; this one does not resolve it.
- **E3** Update `FRONTEND_INTEGRATION.md` (server) and `api-client-guide.md` (frontend) for
  the new PATCH and DTO fields.

### F. Pre-existing gaps noticed in passing (not in this PRD's scope)

- `QuoteInvoiceTab.tsx`'s `FLAG_LABELS` has no entry for `estimated_price`, so that flag
  renders as its raw slug. `quotesService.ts`'s exported `BLOCKING_FLAGS` also omits it,
  while the server's `quoteDto.ts:14-23` includes it.

---

## 3. Open questions

**Q1 — "percentage increase on total" vs. what the PRD specifies.** The verbal ask was a
percentage increase *on the total*. The PRD specifies something different: markup baked into
each **material line item's** displayed price, with labor explicitly never touched and no
subtotal → markup → total breakdown anywhere. Those coincide only on a quote with zero labor
lines, and they render completely differently. Worth reconciling before any code, since it
changes both the math and the UI.

**Q2 — Edit semantics under live markup (blocks D3).** The PRD says "no separate display of
the pre-markup base price anywhere in v1", which conflicts with having editable price fields:
something has to hold the base. Two ways out — the DTO carries both base and displayed price
and the edit fields commit the *base*; or the PATCH divides the markup back out of what was
submitted. The first is better: dividing back out accumulates rounding drift directly into
stored prices, and a technician who edits a line twice would watch it wander. It needs a
one-line PRD amendment allowing the base price in the edit affordance, which is a smaller
concession than corrupting stored data.

**Q3 — Discriminator sequencing (blocks C1).** Ship markup with its own minimal `kind`
column, or wait for the Labor Charges PRD that owns labor modelling? Recommend the former,
per §1.

**Q4 — Manual totals get marked up.** PRD US5 says a manually entered or overridden price
receives markup "the same as any other material line item". Taken literally, a technician who
types a $100 total sees $120. That is what the PRD asks for and it is consistent, but it will
surprise people — confirm it is intended.

**Q5 — No customer email field.** The PRD adds name, address, and phone. But
`emailProposal` / `emailDraft` need a `to` address, currently resolved through
`loadQuoteHeader`. Adding a customer email is not in scope; flagging that the gap stays open.

**Q6 — DDL ownership (blocks A1, C2).** See §1. Nothing in either feature can land without
this settled.
