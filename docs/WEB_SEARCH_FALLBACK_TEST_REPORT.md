# Web-Search Fallback — Test Report

**Date:** 2026-08-14 · **Environment:** production (`458799594709`, us-east-1)
**Deployed:** task def `techcopilot-prod-assistant:68`, image `techcopilot-assistant:4503ec5`
**Method:** dry run against every unpriced line in the live database. No rows were written.

Run as a one-off Fargate task on the deployed image, so the code under test is the code in
production. Each distinct search term went through `lookupHomeDepotViaWebSearch` exactly as the
resolver calls it.

---

## 1. Result

| | |
|---|---|
| Unpriced lines on DRAFT quotes | **294** |
| Distinct terms behind them | **223** |
| Never priceable by design (no `searchTerm` — labour, diagnostics) | **160** |
| Testable terms | **63** |
| **Priced by the fallback** | **43 (68%)** |
| Declined — left blank | **20 (32%)** |
| **Carried a usable product link** | **0 of 43** |
| Median latency | **~3.1 s** |

**Headline:** the fallback prices roughly two thirds of what the catalog left blank, and every one
of those 43 lines would otherwise still be empty today with all three SerpApi keys spent. The 20
declines are the safety valve working — the model was asked to return nothing rather than guess,
and it did.

**The zero is the most important number in this table.** Not one of the 43 results produced a URL
that passed the product-page shape test, so every line gets a Home Depot *search* link. That
retroactively justifies dropping the `estimate_link` column when the DDL turned out to be
impossible: there was nothing to store.

---

## 2. What it priced

Sensible, checkable results across the trades — a sample of the 43:

```
5/8 in ground rod clamp        $4.35/EA    Commercial Electric 5/8 in. Bronze Ground Rod Clamp
ground bar kit                 $12.68/EA   Eaton 14-Terminal Ground Bar Kit
1-gang switch box              $3.09/EA    Southwire 3 in. x 2 in. x 2-1/2 in. Steel Metallic
100A main breaker panel        $119.00/EA  Square D Homeline 100 Amp 20-Space 40-Circuit Indoor
20A AFCI/GFCI dual function    $66.80/EA   Square D Homeline 20-Amp Dual Function Breaker
1 in CPVC 90 elbow             $2.14/EA    1 in. CPVC-CTS 90-Degree Slip x Slip Elbow
CPVC solvent cement            $29.86/EA   Oatey 32 oz. Medium Orange CPVC Cement
60A non-fused AC disconnect    $14.98/EA   60 Amp Non-Fusible Metallic AC Disconnect
```

Several correctly reported per-foot pricing (`6 AWG bare copper $1.63/ft`, `14 AWG THHN
$0.42/ft`), and two picked up pack sizes the rounding rule then honours (`bonding bushing` pack 2,
`1-1/4 in EMT one hole strap` pack 4).

---

## 3. Defects this run exposed

These are the reason the output is labelled an estimate and blocks completion. Every one below
would have reached a customer-facing quote unchallenged if it were stored as a catalog price.

### F1 — Length goods priced per roll, then multiplied by feet *(the $8,950 defect, unfixed)*

```
1 AWG THHN copper wire   ->  $1,890.53/EA   "Southwire 500 ft. 1 Black Stranded CU SIMpull THHN"
12/2 NM-B cable          ->  $42.00/ROLL    "Southwire 25 ft. 12/2 Romex SIMpull"
10 AWG THHN wire         ->  $94.00/ROLL    "Southwire 100 ft. 10 Green Stranded CU THHN"
2 AWG aluminum XHHW wire ->  $399.00/ROLL   "Southwire 500 ft. 2 Black Stranded AL XHHW"
```

The prices are real; the **unit** is the problem. A line asking for 250 ft of 1 AWG, priced at
$1,890.53 "each", produces a six-figure line the same way `12/2 NM-B cable` produced $8,950 on
quote `dafc8e02`. `$1,890.53` also sails through the plausibility bounds, because it is a genuine
price — for a 500 ft roll.

This is the open defect from 2026-08-12 and it is **not specific to the fallback** — the catalog
path has it too. It is now the highest-value open correctness issue in the pricing pipeline.

### F2 — No product-noun constraint on web-search results

```
2 in rigid conduit  ->  $9.78  "2 in. Rigid Conduit Chase Nipple"
```

A chase nipple is not conduit. `matchPricebook` would have rejected this — the product noun is a
hard constraint there since D8 — but the fallback writes the model's pick straight through
without that check. The same guard should apply to both paths.

### F3 — Wildly inconsistent results for equivalent requests

```
10 HP VFD 480V 3 phase   ->  $278.90    VEVOR (consumer import)
7.5 HP VFD 480V 3 phase  ->  $1,944.32  York (OEM)
```

A *smaller* drive priced at seven times the larger one. Both listings are real; they are different
market segments. Nothing in the fallback notices, and a technician skimming would not either.

Same pattern, smaller stakes:

```
circuit directory label  ->  $11.53/EA   Square D
panel circuit directory  ->  $7.50, pack of 2   Eaton
```

### F4 — Unspecified dimensions get silently chosen

```
bonding bushing  ->  "Halex 1-1/2 in. Rigid Insulated Grounding Bushing"
control enclosure -> "Enviro-Tec Electronic Control Enclosure"  $122.77
```

The request named no size, so a size was picked. This is really an upstream `searchTerm` quality
problem — the agent should not emit a dimensionless term for a dimensioned part — but the fallback
makes it visible by putting a price on it.

---

## 4. What it declined, and why that is right

All 20 blanks, verbatim:

```
30A double pole circuit breaker      125A 3 pole circuit breaker
wire connectors                      VFD control enclosure
1 in x 1/2 in sprinkler head adapter service weatherhead
1/2 in 4.9K white pendant sprinkler  panel cover
motor circuit breaker disconnect     branch circuit breaker allowance
  7.5 HP 480V  (x2)                  200A meter main combo 120/240V 1ph
A19 light bulb                       intersystem bonding termination bar
A19 LED bulb                         start / stop push button operator
channel strut support                52 in ceiling fan
decorator wall plate
```

Two things stand out.

**The bulb that started this still comes back blank.** `A19 LED bulb` and `A19 light bulb` both
declined, even though the item is trivial and we already hold `HD-339437587` at $2.66 for company
10. The fallback is not the fix for that case — **sharing the catalog across companies is**, and
this run is the strongest argument yet for it.

**`branch circuit breaker allowance` and `panel cover` are correct declines** — an "allowance" is
not a product, and a bare "panel cover" names no panel. The model returning nothing there is
exactly the designed behaviour.

---

## 5. Reproducing

The dry run selects unpriced, non-manually-edited lines on DRAFT quotes, groups them by
`searchTerm`, and calls the shipped module for each distinct term at concurrency 4, capped at 70
terms. It writes nothing. Run it as a one-off task on the current task definition with the
container command overridden — the pattern in `ESTIMATING_AGENT_TEST_REPORT.md` §9.

Costs OpenAI web-search calls (63 here, ~3.1 s each), and **no SerpApi quota** — which is the
whole point of the fallback.

---

## 6. Recommended order

1. **Fix F1 (length goods).** It is live on both pricing paths, it is the only defect here that
   produces a five-figure error, and it already reached a real quote.
2. **Share Home Depot catalog rows across companies.** Would have priced the bulb, and every other
   term another company has already resolved, for zero API cost.
3. **Apply the product-noun constraint to fallback results (F2).** The rule exists; it is simply
   not wired into this path.
4. **Paid SerpApi plan.** The fallback makes an unreachable catalog survivable — it does not make
   verified prices unnecessary. 43 of 43 results here carry no product link and no product id.
