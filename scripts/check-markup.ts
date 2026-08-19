/**
 * Regression check for the per-quote materials markup.
 *
 * The boundary this exists to hold: markup multiplies MATERIAL lines and never touches labor.
 * Getting that wrong inflates the one cost a contractor quotes most precisely, on every line
 * of every quote at once — so labor exemption, pricing-source uniformity, and the "a printed
 * row must multiply out" rounding rule all get an explicit case here.
 *
 * Pure — no network, no database.
 *   npx tsx scripts/check-markup.ts
 */
import {
  effectiveTotal,
  markedUpPrices,
  stripMarkup,
  toQuoteDto,
} from "../src/copilot/estimating/quoteDto";

const now = new Date();

const line = (
  id: string,
  fields: {
    quantity?: number | null;
    unitPrice?: number | null;
    totalPrice?: number | null;
    isLabor?: boolean;
    pricebookCode?: string | null;
    manuallyEdited?: boolean;
    optionGroup?: string | null;
    sortOrder?: number;
  } = {}
) =>
  ({
    id,
    quoteId: "q1",
    description: id,
    quantity: fields.quantity ?? 1,
    unit: "EA",
    unitPrice: fields.unitPrice ?? null,
    totalPrice: fields.totalPrice ?? null,
    pricebookCode: fields.pricebookCode ?? null,
    searchTerm: fields.isLabor ? null : id,
    optionGroup: fields.optionGroup ?? null,
    isLabor: fields.isLabor ?? false,
    agentSuggested: false,
    manuallyEdited: fields.manuallyEdited ?? false,
    ambiguousAction: null,
    sortOrder: fields.sortOrder ?? 0,
    createdAt: now,
    updatedAt: now,
  }) as any;

const quoteOf = (markupPercent: number, lineItems: unknown[]) =>
  ({
    id: "q1",
    conversationId: "c1",
    status: "DRAFT",
    markupPercent,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    lineItems,
  }) as any;

let pass = 0;
let total = 0;
const check = (name: string, got: unknown, want: unknown) => {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}  want=${JSON.stringify(want)} got=${JSON.stringify(got)}`
  );
};

// ── The labor boundary ────────────────────────────────────────────────────────
// Same numbers on both lines, so only isLabor can explain a difference.
const mixed = toQuoteDto(
  quoteOf(20, [
    line("material", { quantity: 2, unitPrice: 100, pricebookCode: "PB-1", sortOrder: 0 }),
    line("labor", { quantity: 2, unitPrice: 100, isLabor: true, manuallyEdited: true, sortOrder: 1 }),
  ])
);
check("material unit price marked up", mixed.lineItems[0].unitPrice, 120);
check("material line total marked up", mixed.lineItems[0].totalPrice, 240);
check("labor unit price untouched", mixed.lineItems[1].unitPrice, 100);
check("labor line total untouched", mixed.lineItems[1].totalPrice, 200);
check("total = marked-up materials + untouched labor", mixed.total, 440);
check("isLabor is exposed on the DTO", mixed.lineItems.map((l) => l.isLabor), [false, true]);
check("markupPercent is exposed for the input field", mixed.markupPercent, 20);

// ── Zero markup changes nothing ───────────────────────────────────────────────
const zero = toQuoteDto(
  quoteOf(0, [line("material", { quantity: 3, unitPrice: 19.99, pricebookCode: "PB-1" })])
);
check("0% leaves the unit price alone", zero.lineItems[0].unitPrice, 19.99);
check("0% leaves the line total alone", zero.lineItems[0].totalPrice, 59.97);

// ── Uniform across pricing sources (PRD US5) ─────────────────────────────────
const sources = toQuoteDto(
  quoteOf(10, [
    line("pricebook", { unitPrice: 50, pricebookCode: "PB-1", sortOrder: 0 }),
    line("home-depot", { unitPrice: 50, pricebookCode: "HD-12345", sortOrder: 1 }),
    line("web-estimate", { unitPrice: 50, pricebookCode: "EST", sortOrder: 2 }),
    line("manual-override", { unitPrice: 50, manuallyEdited: true, sortOrder: 3 }),
  ])
);
check(
  "every pricing source is marked up identically",
  sources.lineItems.map((l) => l.unitPrice),
  [55, 55, 55, 55]
);

// ── A hand-typed line TOTAL is marked up directly ────────────────────────────
// effectiveTotal prefers a manual total over qty × unit price; markup must keep that
// precedence rather than silently recomputing the line from its unit price.
const manualTotal = toQuoteDto(
  quoteOf(25, [line("allowance", { quantity: 1, unitPrice: 10, totalPrice: 400, manuallyEdited: true })])
);
check("manual line total marked up, not recomputed", manualTotal.lineItems[0].totalPrice, 500);

// ── Rounding: a printed row must multiply out ─────────────────────────────────
// 3 × $10.03 at 21% must not print 3 × $12.14 = $36.41 (the base-total route gives 36.41,
// the unit-first route gives 36.42 — the second is what the row shows).
const rounding = toQuoteDto(quoteOf(21, [line("wire", { quantity: 3, unitPrice: 10.03 })]));
const row = rounding.lineItems[0];
check("displayed unit price rounded to cents", row.unitPrice, 12.14);
check("displayed total = qty × displayed unit price", row.totalPrice, 36.42);
check(
  "row multiplies out for a reader",
  Math.round((row.quantity ?? 0) * (row.unitPrice ?? 0) * 100) / 100,
  row.totalPrice
);

// ── Live multiplier, not a snapshot ──────────────────────────────────────────
const lines = [
  line("first", { unitPrice: 100, sortOrder: 0 }),
  line("added-after-markup-was-set", { unitPrice: 200, sortOrder: 1 }),
];
check("a line added after markup was set still gets it", toQuoteDto(quoteOf(50, lines)).total, 450);
check("changing the percentage re-prices every line", toQuoteDto(quoteOf(10, lines)).total, 330);

// ── Option groups ────────────────────────────────────────────────────────────
const options = toQuoteDto(
  quoteOf(20, [
    line("base-material", { unitPrice: 1000, sortOrder: 0 }),
    line("base-labor", { unitPrice: 500, isLabor: true, sortOrder: 1 }),
    line("optA", { unitPrice: 100, optionGroup: "Option A", sortOrder: 2 }),
  ])
);
check("base total marks up materials only", options.total, 1700);
check("option group total is marked up", options.optionTotals[0].total, 120);
check("combined total is base + marked-up option", options.optionTotals[0].combinedTotal, 1820);

// ── Markup never invents a price ─────────────────────────────────────────────
const unpriced = toQuoteDto(quoteOf(30, [line("no-match", { unitPrice: null, quantity: 2 })]));
check("unpriced line stays unpriced under markup", unpriced.lineItems[0].totalPrice, null);
check("unpriced line contributes nothing", unpriced.total, 0);

// ── stripMarkup: the edit round trip ─────────────────────────────────────────
// The Invoice tab shows marked-up prices and commits what it shows, so a submitted price has
// to survive stripMarkup → markedUpPrices unchanged, or every edit would drift.
const roundTrip = (shown: number, pct: number) => {
  const base = stripMarkup(shown, pct);
  return markedUpPrices(line("x", { quantity: 1, unitPrice: base }), pct).unitPrice;
};
check("round trip at 20% on a round number", roundTrip(120, 20), 120);
check("round trip at 15% on an awkward number", roundTrip(100, 15), 100);
check("round trip at 33% on cents", roundTrip(9.99, 33), 9.99);
check("strip is identity at 0%", stripMarkup(42.5, 0), 42.5);
check("strip leaves a labor price alone", stripMarkup(95, 20, true), 95);

// ── markedUpPrices restates effectiveTotal's precedence, so pin them together ─────
// At 0% markup the two must agree on every line shape, or a later change to one silently
// changes pricing through the other.
for (const shape of [
  line("qty-x-unit", { quantity: 3, unitPrice: 10.03 }),
  line("manual-total-wins", { quantity: 3, unitPrice: 10, totalPrice: 400 }),
  line("total-only", { quantity: null, unitPrice: null, totalPrice: 250 }),
  line("no-quantity", { quantity: null, unitPrice: 10 }),
  line("unpriced", { quantity: 2, unitPrice: null }),
]) {
  check(
    `0% markup matches effectiveTotal (${shape.description})`,
    markedUpPrices(shape, 0).totalPrice,
    effectiveTotal(shape)
  );
}

console.log(`\n──── ${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
