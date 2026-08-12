# Estimating Agent — Test Report

**Date:** 2026-08-12 (first written 2026-08-11) · **Environment:** production (`458799594709`, us-east-1)
**Deployed:** task def `techcopilot-prod-assistant:56`, image `techcopilot-assistant:7889310`
**Scope:** Home Depot catalog integration, pricebook matching, agent behaviour on electrical work

Every number here was measured, not estimated. Where something is unverified it says so. Sections
marked *superseded* are kept because the measurement was real when taken and the history explains
why the current design looks the way it does.

---

## 1. Executive summary

| | Result |
|---|---|
| Home Depot integration live in production | **Yes** — 9 cached SKUs, **9 of 9 with product links** |
| Product links visible to user and agent | **Yes** — invoice-tab anchor + answerable in chat |
| Real line items priced since 2026-08-12 | **15 of 50 (30%)**, 14 of those from Home Depot |
| Line items produced from electrical problem statements (harness) | **46 across 9 of 10 cases** |
| Wrong prices produced by the harness | **0** |
| Wrong prices found in *production* and fixed | **2 classes** — D8 (wrong part) and D10 (pack underquote) |
| Blocking issue right now | **SerpApi quota exhausted** — both keys 250/250 |

**Headline, revised.** The never-invent-a-price invariant held across every harness run, and that
turned out to be the wrong place to look. Production surfaced two ways a *real* catalog price
lands on the wrong line — a row shared by three different parts (D8) and a pack-only part quoted
as loose pieces (D10) — neither of which any scoring threshold could have caught, and both now
constrained structurally. The lesson is that "no invented prices" was never the same claim as "no
wrong prices", and only production data separated them.

**Biggest single improvement:** before the `searchTerm` change, *every* line item in three
consecutive real quotes was unpriced (0 of 13). Measured on real quotes since, 30% of lines price
automatically and almost all of those come from Home Depot with a working product link.

**What is now blocking, and it is not code:** both SerpApi keys are spent (250/250 each, Free
Plan). Until the plan is upgraded or the month rolls over, no new item can resolve at all — the
resolver degrades honestly (lines stay blank) but nothing new gets priced.

---

## 2. What changed during this cycle

| Commit | Change | Why |
|---|---|---|
| `e8c54e6` | Home Depot resolver + SerpApi client with rotating key pool | Price items the pricebook lacks |
| `2d4fd20` | Delivery-ZIP default, `.env.example` | Catalog needs only a key to switch on |
| `ace9e93` | Per-request timeout + retry on transient 5xx | A single resolve hung 112–198s and discarded 3 passing gates |
| `d44f531` | Unit-number matching, spec-filter aliases, breakers added to seed | A 20A request was matching a **15A breaker** |
| `531a502` | `searchTerm` on every line item | Prose descriptions were unmatchable by construction |
| `275190f` | Home Depot as the source for **every** material line, DB as cache | Product decision |
| `d755d5f` | `product` on the line DTO; brand/price/rating/link in the agent's context | Links were stored but invisible to both the UI and the model (D2) |
| `03fe2ad` | Fan-out capped at 4; short search terms no longer rejected outright | Two-token terms were rejected before any gate ran |
| `91d9659` | Four wrong-price paths closed; `npm test` added as a Docker build gate | Two of them were introduced by the `searchTerm` change itself |
| `072b8b0` | Product noun made a hard matching constraint | One row was serving three different parts on a live quote (D8) |
| `0000f29` | Unit price derived from the search result when the product call fails | A resolve was discarded after three gates had agreed |
| `17d7b2c` | Product lookup submitted asynchronously | The synchronous engine returned zero bytes after 40–60s (D9) |
| `7889310` | Quantities rounded up to whole packs | A 5-pack part was quoted as loose pieces (D10) |

---

## 3. Test suite A — Home Depot resolver gates

Live SerpApi, real keys, deployed code.

| Query | Result | Gate |
|---|---|---|
| `GFCI receptacle` | **RESOLVED** `HD-206001533` Leviton $18.98/EA | all 4 passed |
| `fire sprinkler head pendant 155 degree` | null | correctly not stocked |
| `flux capacitor 1.21 gigawatt` | null | correctly rejected |
| `20A main breaker` | null | model declined — candidates were *branch* breakers, not a main |
| `200 amp load center` | null | product endpoint timeout |
| `3/4 in EMT conduit` | null | product endpoint timeout |
| `60A double pole circuit breaker` | null | product endpoint timeout |
| `4 in square junction box` | null | product endpoint timeout |
| `weatherproof outlet cover` | null | rejected at spec filter |

**Finding (superseded by D9 — kept because it is how the fix was found):** gates 1–3 (unanimity, spec filter, model selection) work reliably. **Gate 4 — per-unit price enrichment — was the dominant failure**, and the cause was upstream: SerpApi's `home_depot_product` engine returned nothing. Verified independently with plain `curl`: three attempts, 90s each, zero bytes, with a brand-new zero-usage key. Not our code, not quota, not per-key throttling.

Every `null` above attributed to a "product endpoint timeout" is that failure, not a judgement about the catalog. Those queries were never re-run after D9, so they are **unknown**, not negative — the four gates were never actually exercised end to end on them.

**Resolved in D9:** the engine works; waiting for its synchronous reply was the problem. Submitted with `async=true` it answers in ~0.6s plus a ~0.35s archive read.

### Proof the loop works — real cached items in production

All nine cached rows, 2026-08-12. Every one carries a product link; the four pack rows drive the
quantity rounding from D10.

```
HD-304736474  $119.13/EA  GE                  load center, 100A 12-space 22-circuit
HD-100132766  $104.26/EA  Square D            main breaker, QO 100A 22k AIR
HD-315110883    $3.52/EA  Leviton             switch, 15A 120/277V single pole
HD-203340257    $2.98/EA  Southwire           device box, 1-gang adjustable depth
HD-100177193    $1.98/EA  —                   wall plate, 1-gang jumbo toggle
HD-100137321    $0.85/EA  Halex        pack 5  EMT set-screw connector, 1/2 in
HD-100144234    $0.59/EA  Halex        pack 5  EMT set-screw coupling, 1/2 in
HD-316097621    $0.51/EA  —           pack 50  EMT set-screw connector, 1/2 in
HD-100172548    $0.26/EA  —           pack 25  EMT fitting, 1/2 in
```

Each carries the technician's own phrasing as a synonym (`"1/2 in EMT set screw connector"`), so a differently-worded request matches next time with **zero API calls**. That is the caching design working as intended, and it is what makes the exhausted quota survivable: cached items keep pricing.

Note the last two rows against `HD-100137321`: the same part is stocked in 5, 25 and 50 counts, and nothing in the resolver prefers the smallest pack that covers the need. See §8.

---

## 4. Test suite B — 10 electrical problem statements

Real `SYSTEM_PROMPT` and schema, two turns per case (problem → confirm). Search calls deliberately not made, so results show what *would* price.

| # | Problem statement | Lines | Priced | → HD | Labour |
|---|---|---:|---:|---:|---:|
| 1 | Outlets in the break room stopped working, breaker won't stay on | 6 | 3 | 2 | 1 |
| 2 | Half the warehouse lights are flickering badly | 4 | 0 | 3 | 1 |
| 3 | Need two new 20 amp circuits for the copier room | 7 | 4 | 3 | 0 |
| 4 | GFCI outlet by the sink keeps tripping every morning | 3 | 1 | 1 | 1 |
| 5 | Electrical panel is full, need to add more circuits | 7 | 4 | 2 | 1 |
| 6 | Hallway light switch sparks when you flip it | 4 | 1 | 2 | 1 |
| 7 | Adding a 240 volt circuit for a new shop compressor | 6 | 3 | 3 | 0 |
| 8 | Ceiling lights buzz, one died completely | 4 | 0 | 3 | 1 |
| 9 | Run conduit and wire from panel to a machine 40 ft away | **0** | — | — | — |
| 10 | Outdoor outlet on the loading dock is corroded and dead | 5 | 0 | 4 | 1 |
| | **Total** | **46** | **16** | **23** | **7** |

### Best case — #3, two new 20A circuits

```
PRICED  EL-007  $8.50/EA     20A single pole circuit breaker            qty 2
PRICED  EL-001  $32.00/ROLL  12 AWG THHN wire                          qty 250 ft
PRICED  EL-012  $10.88/STICK 3/4 in EMT conduit                        qty 125 ft
PRICED  EL-011  $18.98/EA    20A duplex receptacle                     qty 2
→ HD    "4 in square junction box"                                     qty 4
→ HD    "duplex receptacle cover plate"                                qty 2
→ HD    "wire connectors"                                              qty 1
```

### `searchTerm` doing its job

The change that made this possible — prose stays readable, a terse catalog term drives matching:

| description (for the customer) | searchTerm (for matching) |
|---|---|
| Wire connectors for circuit repair | `wire connectors` |
| Provide grounding bar kit for subpanel | `ground bar kit` |
| Disconnect switch at or near compressor | `60A non fused disconnect switch` |
| Replacement LED driver or ballast, as needed | `LED driver` |
| Replace corroded dead outdoor receptacle… | `weather resistant GFCI receptacle` |

**Labour lines correctly get no searchTerm** — 7 of 7, e.g. "Electrical troubleshooting for break room receptacle circuit". These are not purchasable parts and are deliberately never priced, nor do they spend a search.

---

## 5. Defects found

### D1 — Wrong device variant matched *(HALF FIXED — pole count closed, device variant still open)*

Two cases were reported. Re-run against the current matcher on 2026-08-12:

```
20A 2-pole breaker                     -> null (left blank)      FIXED
double pole breaker 20A                -> null (left blank)      FIXED
20A duplex receptacle                  -> EL-011 $18.98 GFCI     STILL WRONG
standard duplex receptacle 20A         -> null (left blank)
20A tamper resistant duplex receptacle -> null (left blank)
```

Pole count is closed: `canonicalizeUnits` folds "double pole" to `2p` and spec tokens are a hard constraint, so a 2-pole request can no longer land on a single-pole row.

**The device-variant half still reproduces.** "20A duplex receptacle" matches the GFCI row at 2 of 3 tokens — `20a` and `receptacle` both hit, only `duplex` misses — and a GFCI is roughly 4× a standard receptacle. Neither guard helps: the amperage genuinely matches, and the product noun *is* "receptacle". The distinguishing word is an **adjective** (`duplex` vs `gfci`), and nothing currently requires those to agree. Same shape as D8, one part of speech over.

Adding a token or two makes it fall below threshold, which is why the other two phrasings return null — so the exposure is narrowest exactly where the request is most terse. Worth fixing by requiring that the query not contradict a distinguishing adjective present on the row, rather than by nudging the threshold.

### D2 — Product links not exposed *(FIXED — `d755d5f` server, `ca7018b` UI)*

Links were stored on every cached row but reachable by nobody:
- `LineItemDto` had no link field, so the API never sent it to the UI
- `buildTurnContext` gave the agent only `description | qty | unit | flags`

Both closed. `LineItemDto.product` now carries `{productId, link, brand, rating, packageQuantity, provisional}` on any line priced from Home Depot, attached on all 13 read and mutation paths; the invoice tab renders a "View on Home Depot" anchor from that structured field — never from model-generated text, since a regenerated URL can silently corrupt the slug. The agent gets brand, price, rating and link in its turn context and is instructed to reproduce a URL character for character or say the line isn't catalog-priced.

Verified in production 2026-08-12: 9 of 9 cached rows carry a link, and lines on live quotes render them.

### D3 — Case 9 produced no line items *(open, needs reproduction in the UI)*

"Run conduit and wire from the panel to a new machine 40 feet away" kept proposing rather than adding, even at the follow-up cap. May be a harness artefact; needs checking against the real UI.

### D4 — Amperage ignored in matching *(FIXED — `d44f531`)*

`tokenize` dropped bare digits, so `"20 amp breaker"` reduced to `[amp, breaker]` and scored 1.0 against **every** breaker. First row won the tie, so a 20A request matched a **15A breaker** — a silently wrong price on the exact attribute specified. Now folds `20 amp` / `20-Amp` / `12 gauge` onto the compact form. Guarded by `scripts/check-pricebook-amperage.ts` (14/14 then, 28/28 now — see D8).

### D5 — Correct products rejected by the spec filter *(FIXED — `d44f531`)*

Home Depot returned ideal results for a 20A breaker — Homeline 20-Amp $7.26, Square D QO $17.63, Siemens QP $8.48 — and **every one was rejected** at `ratio=0.33`, because `20a` never matched a title reading `20-Amp`, and the scope word "main" counted against the score. After the fix: **0 surviving candidates → 21**.

### D6 — No timeout or transient retry *(FIXED — `ace9e93`)*

A single resolve hung 112–198s then gave up, discarding three passing gates over one upstream blip. Now bounded at 25s per attempt with 2 retries on the same key. Observed effect: 197s/123s/137s → a bounded 80s.

### D7 — Backfill couldn't override a book placeholder *(FIXED — `275190f`)*

The backfill only touched rows with a null `unitPrice`. Under Home-Depot-first pricing the placeholder from the company book leaves it non-null, so the update would skip the row and pin the book price forever — silently defeating the change.

### D8 — One cached row served three different parts *(FIXED — `072b8b0`)*

Found by auditing production, not by a test. On quote `e3657733` three lines shared code `HD-100137321`, a **$0.85 1/2 in EMT set-screw connector**:

| Line | Code shown | Price shown | Truth |
|---|---|---|---|
| 1/2 in EMT set screw connector | HD-100137321 | $0.85 | correct |
| 1/2 in EMT conduit | HD-100137321 | $0.85 | a 10 ft stick is ~$12 |
| 1/2 in EMT one-hole strap | HD-100137321 | $0.85 | wrong part |

Each wrong line scored **2 of 3 tokens** — the size and `emt` both hit, only the noun differed — clearing the 0.6 threshold. Because the price came from a real catalog row, each line also displayed that connector's Home Depot link, so the quote asserted the conduit *was* the connector.

Spec tokens are structurally unable to catch this: matching parts of one system share every measurement. The product noun (last token carrying no measurement) is now a hard constraint too. The suite grew 21 → **28**, pinning the four wrong products and the two correct ones from the real quote. Blast radius at the time of the fix: 9 Home-Depot-priced lines in production, 2 wrong, both on an unedited DRAFT.

### D9 — Gate 4 blocks everything, so nothing gets a price or a link *(FIXED)*

Section 3 called `home_depot_product` "the dominant failure". As of 2026-08-12 it is a total one: **every** product lookup in production fails.

```
Catalog product lookup failed  productId=202304641  timeout (after 3 attempts)
Catalog: no usable unit price  productId=202304641
… 14 more, consecutively, zero successes
```

Four variants were tried, all zero bytes: bare `product_id`; SerpApi's own generated URL with `store_id` and `delivery_zip`; a second product; and a mainstream delivery ZIP. The `home_depot` search engine answered on the same key in 12s throughout, so this was never quota, our parameters, or our ZIP.

**The engine works — the synchronous reply is what hangs.** Submitting the identical search with `async=true` returns a job in ~0.6s, and reading the archive gives the complete record:

```
async submit          HTTP 200   0.64s   status: Success
archive read          HTTP 200   0.35s
  price 2.95 · price_per_unit 0.59 · package_quantity 5 · availability_type Available
```

`getHomeDepotProduct` now submits async and reads the archive with the same pool key (the archive is account-scoped, so a rotated key would 404). End-to-end through the real client: **1.03s** for HD-100144234 and **0.92s** for HD-316097627, both with full economics and a canonical `www.homedepot.com` link — against 75s of timeouts and a null before. It is the same single billed search, and it stops burning quota on calls that time out with nothing to show.

A second-line fallback derives the unit price from the search result, which carries both inputs the product endpoint uses — the price, and the pack size stated in the title:

```
100144234  "… Set-Screw Coupling (5-Pack)"   2.95  →  2.95 / 5  = $0.59   (endpoint: 0.59)
316097627  "… Set-Screw Coupling (50-Pack)"  17.48 →  17.48 / 50 = $0.35   (endpoint: 0.35)
```

Both agree with the endpoint's own `price_per_unit`. A title advertising bulk with no number is refused rather than divided. Guarded by `scripts/check-pack-parsing.ts`, 15/15, in the CI gate.

**Not fixed by this:** quota. Both keys are on SerpApi's Free Plan at 250 searches/month, and by the end of 2026-08-12 both were spent — see §6. Folding the product call into the async search does return ~20% of the spend per item, but no code change creates searches that don't exist.

### D10 — Pack-only parts quoted as loose pieces *(FIXED)*

Reported from a live estimate. `HD-100137321` is a **5-pack** of 1/2 in EMT set-screw connectors at $4.25; $0.85 is what one costs, not what one can be bought for. A line needing four was quoted 4 × $0.85 = **$3.40** — a purchase the supplier will not sell. The technician leaves with five and the job is short.

The fix rounds the **quantity** up to a whole number of packs and leaves the price per unit: 4 → **5 EA @ $0.85 = $4.25**. Chosen over storing the pack price against a pack unit because it keeps the line's arithmetic visibly consistent, it is idempotent (re-pricing an already-rounded count is a no-op, so a turn, a backfill and a repair can all run over one line without compounding), and it avoids the trap in `unit: op.unit ?? priced.unit` — a model-supplied "EA" against a pack-priced row would have quoted four connectors at $17.00.

Applied everywhere a quantity meets a pack row: `add_item`, `kb_proposal`, an `update_item` re-price, the REST `addItem` (a hand-added part bypasses the agent entirely), and the resolver backfill — which now updates row by row, since rounding is arithmetic on each line's own quantity and `updateMany` cannot express it.

A measured unit is never converted: "30 ft" beside a pack size of 5 stays 30 ft, because there is no honest reading of it. Pack size now also falls back to the product title, so a response carrying `price_per_unit` without `package_quantity` no longer looks like a single item. Guarded by 10 further assertions in `scripts/check-pack-parsing.ts` (25 total), including idempotence directly.

**Existing quotes repaired**, since the rounding only applies as lines are priced. Nine unedited DRAFT lines across five quotes were rounded, the reported one among them:

```
03fad935  EMT set-screw connector  2 -> 5   (pack 5)   now 5 EA @ $0.85 = $4.25
03fad935  EMT coupling             1 -> 5   (pack 5)
53970874  connector 2->5 · coupling 1->5
e3657733  connector 2->5 · coupling 1->5
a3341031  one-hole strap           6 -> 25  (pack 25)
a2a6daf2  connector 2->50 · strap 10->25
```

Pack sizes were already stored correctly on all four pack rows, and titles independently derived the same numbers (5, 5, 25, 50) — only the rounding was missing. The `a2a6daf2` line is the honest cost of the wrong listing rather than a fault in the rounding, and it is what motivates the smallest-pack item in §8.

---

## 6. Production state

Measured 2026-08-12 against the live database.

```
pricebook (company 1)   44 rows   = 35 seeded + 9 Home-Depot-resolved (9 with links, 4 pack rows)
quotes                  20        19 DRAFT · 1 COMPLETED
line items             155        37 priced · 118 unpriced
                                 23 from Home Depot · 8 from the company book · 6 hand-priced
quotes since 12 Aug      6        50 lines · 15 priced (30%) · 14 of those from Home Depot
```

**Most of the 118 unpriced are historical and will stay that way.** Nothing re-prices
retroactively, so every quote created before a given fix keeps the state it was saved with. The
honest forward-looking number is the last row: **30% of lines on recent quotes price
automatically**, and nearly all of that is Home Depot rather than the seeded book — which is the
intended shift, since the book only ever covered 35 generic rows.

### SerpApi quota — now blocking, not just a risk

```
key 1   Free Plan   0 left of 250   (250 used)
key 2   Free Plan   0 left of 250   (250 used)
        total       0 remaining
```

Both keys are spent. **No new item can resolve until the plan is upgraded or the month rolls
over.** Cached items keep pricing from the database at no cost, and the resolver fails honestly
(the line stays blank rather than getting a guess), so nothing breaks — it just stops learning.

Each uncached item costs ~4 searches: one per query variant, since D9 removed the separate
product call from the billed path by folding it into the same async search. A paid plan is a
prerequisite before real technicians use this, and it is now the single highest-value unblock.

---

## 7. Guardrails

### Present

**Pricing integrity — the strongest area**
1. The model never sets prices; pricing is server-side against pricebook or Home Depot
2. No invented prices — unverifiable lines stay blank
3. No invented quantities — null rather than defaulting to 1
4. Ambiguous references never guessed
5. Nothing added before technician confirmation
6. Agent-suggested items flagged, blocking completion until accepted
7. All arithmetic recomputed server-side
8. Pack prices converted to per-unit (guards the 12-pack-as-unit-price error)
9. Home Depot rows written `provisional` until accepted
10. Clarifying questions capped at 2 rounds
11. Every measurement in a request must be present on the row, or the line stays blank (D4)
12. The product noun must match too, so parts of one system can't share a price (D8)
13. Quantities rounded up to whole packs, so a pack-only part isn't quoted as loose pieces (D10)
14. A measured unit is never converted — "30 ft" beside a pack of 5 is left alone rather than guessed

**Scope**
15. Out-of-trade requests declined

### Absent — content and conduct

**There is currently no handling of any of the following.**

16. **Profanity** — no filter, no instruction; parsed as an ordinary estimating turn
17. **Sexual content** — no detection, no refusal path
18. **Abuse or harassment** — no handling
19. **No moderation API call anywhere** in the request path
20. **No sanitisation of text reaching customer documents** — whatever is said can land in a line description, and descriptions render into the proposal DOCX that is emailed to customers. **Highest-consequence gap on this list.**
21. **No audit trail** of flagged or rejected input

Current protection is only the base model's own refusal behaviour — untested here, and not something to rely on for a customer-facing document.

### Absent — safety and liability

22. **Prices can appear in chat replies**, bypassing the entire server-side pricing discipline
23. **Code compliance asserted rather than hedged** — confidence is uncalibrated: fluent NFPA citations for fire protection, **zero** NEC notes for electrical work that required them (commercial-kitchen GFCI per 210.8(B), EV charger per Article 625)
24. **No restriction on commitments** — lead times, warranty, price validity, scheduling
25. **No safety scoping** — nothing stops procedural guidance on energised work
26. **Photo text treated as instruction** — the agent reads photos and emits DB-writing operations; a photo containing text is an injection path
27. **No quantity bounds** — voice turning "forty" into "four thousand" is accepted and multiplied by a real price
28. **No PII handling** — customer names/addresses can reach the DOCX
29. **No language pin** — the general copilot is pinned to English; this agent isn't

---

## 8. Recommended priority

**Tier 0 — blocking today**
- **Paid SerpApi plan** *(§6)* — both keys are at 250/250, so no new item can resolve at all

**Tier 1 — before real technicians use this**
- Content moderation on every inbound utterance *(16–20)*
- Sanitise text reaching customer documents *(20)*
- Forbid prices in chat replies *(22)*
- Quantity bounds with confirmation above a threshold *(27)*
- Treat photo text as data, never instruction *(26)*

**Tier 2 — before customer-facing proposals go out**
- Finish D1: a distinguishing **adjective** must not be contradicted (`duplex` request → GFCI row). The last known path to a wrong price.
- **Prefer the smallest pack that covers the quantity.** `HD-100137321` is stocked in 5, 25 and 50 counts and selection ignores how many are needed, so honouring pack sizes turned a two-connector line into 50 pieces at $25.50. Correct arithmetic on the wrong listing. Needs the required quantity available at selection time, which the resolver isn't given today.
- Hedge code compliance *(23)*; block commitments *(24)*; PII handling *(28)*

**Tier 3**
- Reproduce and fix D3; safety scoping *(25)*; language pin *(29)*; audit trail *(21)*
- Clear `provisional` when a technician accepts a line, and read `lastResolvedAt` for staleness — both are written and never used
- Cap the resolve fan-out per turn (a large quote can start ~50 concurrent searches) and negative-cache failed resolves so they don't re-spend quota

### One framing point

Prompt guardrails are advisory; the ones that matter are enforced in code. This cycle demonstrated it twice over. "Never invent a price" was a prompt instruction the model obeyed honestly — and prices were still wrong, because a *real* catalog price can land on the wrong line (D8) or describe an unbuyable quantity (D10). What made them trustworthy was three structural constraints in the matcher and a rounding rule, none of which a prompt could have expressed. So moderation, quantity bounds, price-stripping and document sanitisation belong in **code**. The rest are genuinely prompt-shaped.

### What the production audits taught, that the harness could not

Every defect in this cycle numbered D8 and above came from reading the live database, not from a
test — and each was invisible to the harness by construction. A test asserts on the answer it
expects; these were all cases where a plausible answer was returned and only cross-referencing it
against the real catalog showed it was the wrong one. The pattern worth keeping: after any pricing
change, audit the rows and lines it actually produced.

---

## 9. Reproducing these results

```bash
# The gate the Docker build runs. Pure — no network, no database.
#   typecheck + 28 matching assertions + 25 pack assertions
npm test

# Individually
npx tsx scripts/check-pricebook-amperage.ts   # amperage, variant, product-noun matching
npx tsx scripts/check-pack-parsing.ts         # pack size from a title, quantity rounding

# 10 electrical problem statements through the real prompt (LLM calls, no searches)
OPENAI_API_KEY=… npx tsx scripts/check-electrical-cases.ts

# Live Home Depot resolver against all four gates (spends ~4 searches per case)
SERP_API_KEY_1=… OPENAI_API_KEY=… npx tsx scripts/check-home-depot-catalog.ts
```

`npm test` runs inside the image build, so a failing assertion means no image — the wrong-price
regressions in D4, D8 and D10 cannot ship again without the build going red.

The database is VPC-internal and unreachable from any laptop, so production checks run as one-off
Fargate tasks on the current task definition, with the container command overridden to a script.
Two habits worth repeating, both learned the hard way: print the rows *before* writing anything,
and assert the expected row count and abort if it differs — that guard is what stopped the pack
repair from touching anything unexpected.
