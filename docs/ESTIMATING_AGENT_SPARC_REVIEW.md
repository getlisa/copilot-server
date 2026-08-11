# SPARC Review — Estimating Agent pricing pipeline

**Date:** 2026-08-11 · **Scope:** `bdc707d..HEAD` on main (613 executable changed lines)
**Subject:** Home Depot catalog integration, pricebook matching, quote line pricing

Reviewed through Specification → Pseudocode → Architecture → Refinement → Completion.
Each stage carries a grade and, where the stage found a gap, the artefact that closes it.

| Stage | Grade | One-line verdict |
|---|---|---|
| **S**pecification | B | Invariants are stated but were never written as testable acceptance criteria |
| **P**seudocode | D → B | The pricing algorithm existed only as prose comments. Written out in §2 |
| **A**rchitecture | C+ | Correct boundaries, but two overlapping normalisation schemes are a live drift risk |
| **R**efinement | A | Seven defects found, five fixed, every change driven by measurement |
| **C**ompletion | D → B | No CI gate existed. `npm test` added and wired into the Docker build |

---

## 1. Specification — grade B

### What is well specified

The invariant is unambiguous and stated in three places (`docs/ESTIMATE_CATALOG_ARCHITECTURE.md` §1, the header of `homeDepotCatalog.ts`, the header of `pricebookMatch.ts`):

> **Never invent a price.** An item that cannot be verified stays blank for the technician.

That is a good specification: falsifiable, and it names the failure it exists to prevent. It's also *enforced* rather than merely stated — the never-invent property is upheld by server-side code, not by asking a model nicely.

Secondary invariants, all clearly stated:
- The model selects and estimates hours; it never prices
- Quantities are never invented (null rather than defaulting to 1)
- An ambiguous reference is never guessed
- A technician's manual edit always wins over any automated price

### The gap

**None of it was written as acceptance criteria.** "Never invent a price" is a property, not a test. Before this review there was no answer to *"what observable behaviour would prove the invariant holds?"* — which is why the 20A-matched-a-15A-breaker defect survived until a human happened to eyeball a table.

Specific ambiguities found:

| Ambiguity | Consequence |
|---|---|
| "Verified" was never defined | The four catalog gates *are* the definition, but nothing said so, so gate 4 failing silently read as a bug rather than the spec working |
| No stated tolerance for a *wrong-but-real* price | Retrieval-correct/selection-wrong (GFCI for a plain receptacle) is a distinct failure from inventing a price, and was never specified as in-scope |
| "Home Depot must be used for every item" arrived mid-implementation | Reversed the priority order after the code was built around pricebook-first; a specification change, not a bug |

### Closing artefact

`scripts/check-pricebook-amperage.ts` now encodes 14 acceptance assertions, including three prose descriptions that **must** stay unmatched — the first executable statement of the invariant. Extend that file when the spec grows; it is the spec now.

---

## 2. Pseudocode — grade D → B

The pricing decision was the highest-risk logic in the change and existed **only** as prose comments spread across two files. A reader could not derive the algorithm without reading every branch. Written out here; this section is the reference.

### 2.1 Line-item pricing (`priceFields`, `estimatingAgent.ts`)

```
INPUT:  description   — human-readable, shown on the quote
        searchTerm    — terse catalog part name, or null for pure labour
        explicitCode  — pricebook code from a KB proposal, or null
        companyId

  term := trim(searchTerm) or null

  # 1. CACHE — already resolved from Home Depot for this company. Costs nothing.
  hit := match(term or description) over rows WHERE source = HOME_DEPOT
  IF hit: RETURN (hit.code, hit.unitPrice, hit.unit)

  # 2. ALWAYS consult Home Depot for anything not cached. Backgrounded: a cold
  #    search is ~13s, far too slow to block the turn.
  IF term: enqueueResolve(term, companyId, description)      # fire-and-forget

  # 3. PLACEHOLDER — the company's own book, so a covered line is never blank
  #    while the resolve runs. A KB proposal's explicit code wins here.
  own := explicitCode ? byCode[explicitCode] : match(term or description) over source = MANUAL
  IF own: RETURN (own.code, own.unitPrice, own.unit)

  # 4. NOTHING — stay unpriced. Never guess.
  RETURN (null, null, null)

INVARIANT: a null searchTerm means "not a purchasable part" — no lookup, no price,
           and no search quota spent.
```

**Why step 3 exists and step 2 precedes it:** the product decision is Home-Depot-first, but a first-time resolve takes seconds to minutes. Returning blank in the meantime would regress a line the book already covers, so the book value is shown and then *overridden* by the resolve.

### 2.2 Catalog resolution (`resolveFromHomeDepot`, `homeDepotCatalog.ts`)

```
INPUT: searchTerm, companyId

  variants := queryVariants(searchTerm)          # up to FANOUT=4, deduped
  IF variants empty: RETURN null

  resultSets := parallel search(variant) for each variant, dropping failures
  IF resultSets empty: RETURN null

  # GATE 1 — absence detector. The ONLY reliable "does Home Depot stock this at
  # all" signal. Measured: a stocked item had 2 unanimous products, an unstocked
  # one had 0. It is NOT a correctness signal (an item with 18 unanimous products
  # still resolved wrong).
  IF |resultSets| = 1: log "absence check skipped"; agreed := all products
  ELSE: agreed := products present in EVERY result set
  IF agreed empty: RETURN null                              # not stocked

  # GATE 2 — spec tokens. With no reference price for a pricebook miss, this is
  # the ONLY thing between a real-but-wrong product and the quote.
  filtered := agreed WHERE brand not in IRRIGATION_DENYLIST
                       AND >= 50% of the term's non-scope tokens appear in title
                       (unit spellings aliased: 20a ~ "20 amp" ~ "20-Amp")
  IF filtered empty: RETURN null

  # GATE 3 — model picks from TITLES, and may decline. Never ranks on price: a
  # resolver that did scored 2/12, choosing a 4 lb extinguisher for a 10 lb line.
  winner := LLM_select(searchTerm, filtered[0..8])
  IF winner is null: RETURN null                            # declined

  # GATE 4 — per-unit economics. Search returns PACK price only, so a 12-pack at
  # $95.99 would otherwise be stored as a $95.99 unit price.
  detail := product_lookup(winner.productId)                # requires delivery_zip
  unitPrice := detail.price_per_unit or detail.price / (packageQuantity or 1)
  IF unitPrice missing or <= 0: RETURN null
  IF detail.availability indicates unavailable: RETURN null

  upsert PricebookItem(companyId, code = "HD-<productId>",
                       source = HOME_DEPOT, provisional = true,
                       synonyms += searchTerm)
  RETURN resolved item
```

**Every gate can only ever reject.** No gate invents, substitutes or relaxes. That is what makes the invariant structural rather than aspirational.

### 2.3 Backfill (`enqueueResolve`)

```
  resolved := resolveFromHomeDepot(searchTerm, companyId)
  IF null: RETURN

  UPDATE quote_line_items
    SET unitPrice, unit, pricebookCode = resolved.code
    WHERE description = (lineDescription or searchTerm)
      AND manuallyEdited = false           # a human edit always wins
      AND quote.companyId = companyId AND quote.status = DRAFT
      AND (unitPrice IS NULL OR pricebookCode IS NULL
           OR pricebookCode NOT LIKE 'HD-%')   # override a book placeholder
```

> **Reviewer note:** matching lines by `description` string equality is the weakest
> link in this algorithm. Two lines sharing a description, or a description edited
> between enqueue and backfill, would mis-target. Flagged to the adversarial lens;
> the durable fix is to carry the line id rather than match on text.

---

## 3. Architecture — grade C+

### Sound

**Layering is right.** The model proposes; the server decides. `estimatingAgent` chooses codes and quantities, `priceFields` prices, `quoteDto` serialises, and nothing downstream trusts a model-supplied number. That separation is why no test in this cycle produced an invented price.

**The cache is the right shape.** Using `PricebookItem` as the Home Depot cache — rather than a parallel table — means `matchPricebook` finds resolved items with no new code path, and the catalog *learns* by accumulating the technician's own phrasing in `synonyms`. Elegant and cheap.

**Correct insertion point.** The whole integration hangs off one branch: the pricebook miss in `priceFields`. Small blast radius, easy to disable (no key configured → `isCatalogEnabled()` false → complete no-op).

**Failure direction is right.** Every degraded path lands on *unpriced*, never on *wrongly priced*.

### Weak

**Two overlapping normalisation schemes.** `pricebookMatch.ts` has `canonicalizeUnits` + `tokenize` + `variants`; `homeDepotCatalog.ts` has `tokenAliases` + `SCOPE_WORDS`. Both normalise "20a" ↔ "20 amp" by different mechanisms. They will drift: a unit added to one and not the other yields a term that matches the pricebook but not Home Depot, or vice versa. **Recommendation:** extract one `textNormalize` module owning units, aliases and stopwords; have both matchers consume it.

**Threshold constants are scattered and unexplained at point of use.** `MATCH_THRESHOLD = 0.6` (pricebookMatch), the `0.5` spec-filter ratio (homeDepotCatalog), `FANOUT = 4`, `TRANSIENT_RETRIES = 2`. Each is defensible and now commented, but they are separate tuning knobs for one behaviour — "how close is close enough". **Recommendation:** co-locate them with the measurement that justifies each.

**No trade dimension.** `PricebookItem` has no trade column, so a company's fire-protection and electrical rows compete in the same match space. `EL-*`/`FA-*` code prefixes are a convention, not a constraint. This is how a fire-alarm labour code could price an electrical panel in the older estimate graph.

**`inFlight` de-dup is per-process.** Correct for one task, ineffective across replicas. Currently desired-count 1, so latent rather than live — but it will surface on scale-out.

---

## 4. Refinement — grade A

The strongest stage, and the reason to trust the result. Every change traces to a measurement rather than an opinion.

| Defect | How it was found | Evidence that fixed it |
|---|---|---|
| Amperage ignored → 20A matched a 15A breaker | Reading a results table | `tokenize("20 amp breaker")` now yields `[20a, breaker]`; 14/14 assertions |
| Correct products rejected by spec filter | Printing per-candidate scores against live API | `20A main breaker`: 0 surviving candidates → 21 |
| Prose descriptions unmatchable | 3 consecutive real quotes, 0/13 priced | `searchTerm` added; 46 lines → 35% priced, 50% resolvable |
| No timeout / no transient retry | A resolve hung 112–198s | Bounded to 80s with a precise error |
| Backfill could not override a book placeholder | Tracing the new priority order | WHERE clause extended; caught before shipping |
| Short terms rejected before any gate | Measuring variant counts on 23 real terms | Dead-end terms 3 → 0 |
| Fan-out cost | Measured 5 vs 3 on real terms | 5→4; rejected 3 because absence detection degraded 7/10 |

Two refinement behaviours worth preserving as practice:

1. **A false conclusion was corrected by measurement.** A resolver scored 2/12 and the initial read was "Home Depot lacks coverage." Printing the candidate pool showed the correct item *was* retrieved and a price-proximity tie-break had discarded it. The scoring function was the defect, not the catalog.
2. **A "test failure" was traced to the harness twice** — once to a missing conversation history, once to a filtered log stream — rather than accepted as a product defect.

---

## 5. Completion — grade D → B

### What was missing

No `test` script. No CI gate. Three verification scripts existed but were **manual**, so nothing stopped a regression reaching production. Given that the failure mode is *a wrong price on a customer-signed document*, that was the most serious process gap in the change.

### Closed by this review

```
npm run typecheck      tsc --noEmit
npm run check:pricebook  14 pricing assertions — hermetic: no network, no DB, no credentials
npm run check:electrical 10 electrical problem statements   (needs OPENAI_API_KEY)
npm run check:catalog    live resolver, all 4 gates          (needs SERP_API_KEY_*, spends quota)
npm test               typecheck + check:pricebook          ← the CI gate
```

`npm test` is now a build step in the `Dockerfile`, so **a build that would misprice a line item fails before it ships.** Verified passing: 14/14.

The credentialed checks stay manual by design — `check:catalog` spends real search quota from a small monthly budget, and putting that in CI would exhaust it.

### Remaining completion gaps

| Gap | Severity |
|---|---|
| `tsconfig` excludes `scripts/`, so the verification scripts are themselves not typechecked (`tsx` transpiles without checking) | Low — a broken script fails loudly when run |
| No assertion covers the **backfill** path or `priceFields`' four-step order — the two highest-risk pieces of logic | **Medium** — these are exactly where a wrong price could originate |
| No test for device-variant matching (the known open defect) | Medium — add the failing case first, then fix |
| `provisional: true` rows are never refreshed; `lastResolvedAt` is written but nothing reads it | Medium — prices silently go stale |
| Quota exhaustion has no alert; searches simply stop resolving | Medium — operationally invisible |

---

## 6. Actions, in order

1. **Add assertions for `priceFields`' four-step order and the backfill WHERE clause.** Highest-risk logic, currently untested. (Completion)
2. **Fix device-variant matching** — pole count, device type, grade. Write the failing assertion first. (Specification + open defect)
3. **Carry the line id through `enqueueResolve`** instead of matching on `description` text. (Architecture — removes the algorithm's weakest link)
4. **Extract one `textNormalize` module** consumed by both matchers. (Architecture — kills the drift risk)
5. **Add a trade column to `PricebookItem`.** (Architecture — prevents cross-trade matching)
6. **Refresh `provisional` rows on a schedule** using `lastResolvedAt`. (Completion)
7. **Alert on quota exhaustion.** (Completion)

Items 1–3 are the ones that bear on the pricing invariant; 4–7 are structural and operational.
