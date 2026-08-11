# Estimating Agent — Test Report

**Date:** 2026-08-11 · **Environment:** production (`458799594709`, us-east-1)
**Deployed:** task def `techcopilot-prod-assistant:47`, image `techcopilot-assistant:275190f`
**Scope:** Home Depot catalog integration, pricebook matching, agent behaviour on electrical work

Every number here was measured, not estimated. Where something is unverified it says so.

---

## 1. Executive summary

| | Result |
|---|---|
| Home Depot integration live in production | **Yes** — 3 real SKUs cached, with links and brands |
| Line items produced from electrical problem statements | **46 across 9 of 10 cases** |
| Would price from the company pricebook | **16 (35%)** |
| Would route to Home Depot | **23 (50%)** |
| Correctly left unpriced (labour/diagnostic) | **7 (15%)** |
| Wrong prices produced | **0** |
| Product links visible to user or agent | **No** — stored but not exposed |

**Headline:** the never-invent-a-price invariant held throughout. No test at any point produced a wrong price on a customer-facing line. The remaining gaps are **recall** (items we can't find) and **surfacing** (data we hold but don't show), not correctness — and recall is the safer side to be short on.

**Biggest single improvement this cycle:** before the `searchTerm` change, *every* line item in three consecutive real quotes was unpriced (0 of 13). After it, 35% price instantly from the pricebook and another 50% have a usable catalog term.

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

**Finding:** gates 1–3 (unanimity, spec filter, model selection) work reliably. **Gate 4 — per-unit price enrichment — is the dominant failure**, and the cause is upstream: SerpApi's `home_depot_product` engine intermittently times out. Verified independently with plain `curl`: three attempts, 90s each, zero bytes, with a brand-new zero-usage key. Not our code, not quota, not per-key throttling.

**When that endpoint responds, resolution works end to end**, including the database write.

### Proof the loop works — real cached items in production

```
HD-203340257  $2.98/EA  Southwire  provisional  link ✅  Smart Box 1-Gang Adjustable Depth Device Box
HD-100137321  $0.85/EA  Halex      provisional  link ✅  1/2 in. EMT Set-Screw Connector
HD-100144234  $0.59/EA  Halex      provisional  link ✅  1/2 in. Standard EMT Fitting
```

Each carries the technician's own phrasing as a synonym (`"1/2 in EMT set screw connector"`), so a differently-worded request matches next time with **zero API calls**. That is the caching design working as intended.

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

### D1 — Wrong device variant matched *(open, medium severity)*

Case 7 asked for a **2-pole** breaker and matched `EL-006` **15A single-pole** $7.25. Case 3 asked for a plain **20A duplex receptacle** and matched `EL-011` **GFCI** $18.98 — a GFCI is roughly 4× a standard receptacle.

The matcher has no notion of pole count or device variant. Same class as the amperage defect already fixed (D4), and it produces a **plausible but wrong price**, which is the failure mode that matters most.

### D2 — Product links not exposed *(open, low severity, high visibility)*

Links **are** stored — all 3 cached rows have `externalLink`. But:
- `LineItemDto` has no link field, so the API never sends it to the UI
- `buildTurnContext` gives the agent only `description | qty | unit | flags`

So asking the assistant "give me the link" fails because it genuinely cannot see one. Two small additions fix both. This was scoped as step 7 and never built.

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

---

## 6. Production state

```
pricebook (company 1)   38 rows   = 35 seeded + 3 Home-Depot-resolved
quotes                   9        all DRAFT
line items              55        8 priced · 47 unpriced · 3 priced from Home Depot
```

**The 47 unpriced are mostly historical.** Quotes `d337c56c`, `6de0c43a`, `0bc1cfc7`, `670080a5`, `4668fa48` were all created *before* the fixes deployed, and nothing re-prices retroactively. The forward-looking figure is suite B's **35% priced instantly, 50% with a usable catalog term** — not the 15% the historical table shows.

### SerpApi quota — needs attention

```
key 1   Free Plan   66 left of 250   (184 used)
key 2   Free Plan  169 left of 250   ( 81 used)
        total      235 remaining
```

Each uncached item costs **5 searches**, so ~47 distinct new items remain. Cached items are free forever after the first resolve, so this converges — but **a paid plan is a prerequisite before real technicians use this.** Key 1 is approaching exhaustion.

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

**Scope**
11. Out-of-trade requests declined

### Absent — content and conduct

**There is currently no handling of any of the following.**

12. **Profanity** — no filter, no instruction; parsed as an ordinary estimating turn
13. **Sexual content** — no detection, no refusal path
14. **Abuse or harassment** — no handling
15. **No moderation API call anywhere** in the request path
16. **No sanitisation of text reaching customer documents** — whatever is said can land in a line description, and descriptions render into the proposal DOCX that is emailed to customers. **Highest-consequence gap on this list.**
17. **No audit trail** of flagged or rejected input

Current protection is only the base model's own refusal behaviour — untested here, and not something to rely on for a customer-facing document.

### Absent — safety and liability

18. **Prices can appear in chat replies**, bypassing the entire server-side pricing discipline
19. **Code compliance asserted rather than hedged** — confidence is uncalibrated: fluent NFPA citations for fire protection, **zero** NEC notes for electrical work that required them (commercial-kitchen GFCI per 210.8(B), EV charger per Article 625)
20. **No restriction on commitments** — lead times, warranty, price validity, scheduling
21. **No safety scoping** — nothing stops procedural guidance on energised work
22. **Photo text treated as instruction** — the agent reads photos and emits DB-writing operations; a photo containing text is an injection path
23. **No quantity bounds** — voice turning "forty" into "four thousand" is accepted and multiplied by a real price
24. **No PII handling** — customer names/addresses can reach the DOCX
25. **No language pin** — the general copilot is pinned to English; this agent isn't

---

## 8. Recommended priority

**Tier 1 — before real technicians use this**
- Content moderation on every inbound utterance *(12–16)*
- Sanitise text reaching customer documents *(16)*
- Forbid prices in chat replies *(18)*
- Quantity bounds with confirmation above a threshold *(23)*
- Treat photo text as data, never instruction *(22)*
- Paid SerpApi plan *(§6)*

**Tier 2 — before customer-facing proposals go out**
- Fix D1 (device-variant matching) — the only open defect that yields a wrong price
- Fix D2 (expose product links) — small, and it's the most visible missing feature
- Hedge code compliance *(19)*; block commitments *(20)*; PII handling *(24)*

**Tier 3**
- Reproduce and fix D3; safety scoping *(21)*; language pin *(25)*; audit trail *(17)*

### One framing point

Prompt guardrails are advisory; the ones that matter are enforced in code. This cycle demonstrated it: "never invent a price" was a prompt instruction the model obeyed honestly, but what made prices *trustworthy* was a server-side validator. So moderation, quantity bounds, price-stripping and document sanitisation belong in **code**. The rest are genuinely prompt-shaped.

---

## 9. Reproducing these results

```bash
# Pure, no network or DB — amperage/variant/product-noun regression suite (28 assertions)
npx tsx scripts/check-pricebook-amperage.ts

# 10 electrical problem statements through the real prompt (LLM calls, no searches)
OPENAI_API_KEY=… npx tsx scripts/check-electrical-cases.ts

# Live Home Depot resolver against all four gates (spends ~5 searches per case)
SERP_API_KEY_1=… OPENAI_API_KEY=… npx tsx scripts/check-home-depot-catalog.ts
```

The database is VPC-internal and unreachable from any laptop, so production checks run as one-off Fargate tasks on the current task definition — see the session transcript for the pattern.
