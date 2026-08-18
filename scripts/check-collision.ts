/**
 * Regression check for the multi-pricebook matching order (pricebook-config PRD US1):
 * higher price wins a cross-book collision regardless of priority; an exact price tie goes
 * to the higher-priority book; the HD cache prices a miss only when fallback is on; and a
 * fallback-off client with no books gets nothing.
 *
 * Pure — no network, no database.
 *   npx tsx scripts/check-collision.ts
 */
import { matchPools, MatchableRow, MatchPool } from "../src/copilot/estimating/companyPricing";

const row = (code: string, description: string, unitPrice: number): MatchableRow => ({
  id: 0,
  code,
  description,
  unit: "EA",
  unitPrice,
  synonyms: [],
  packageQuantity: null,
});

const bookA: MatchPool = {
  id: 1,
  name: "Supplier A",
  items: [row("B1:X", "20A single pole circuit breaker", 8.5)],
};
const bookB: MatchPool = {
  id: 2,
  name: "Supplier B",
  items: [row("B2:X", "20A single pole circuit breaker", 11.25)],
};
const bookBTied: MatchPool = {
  id: 2,
  name: "Supplier B",
  items: [row("B2:X", "20A single pole circuit breaker", 8.5)],
};
const hdCache = [row("HD-123", "20A single pole circuit breaker", 9.99)];

let failures = 0;
const expect = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else console.log(`ok   ${label}`);
};

const TERM = "20A single pole circuit breaker";

// Collision at different prices → the HIGHER price wins, even from the lower-priority book.
const collision = matchPools(TERM, [bookA, bookB], [], false);
expect("higher price wins a collision", [collision?.unitPrice, collision?.sourcePricebookId], [11.25, 2]);

// Exact price tie → the higher-priority (first) book is shown as the source.
const tie = matchPools(TERM, [bookA, bookBTied], [], false);
expect("price tie goes to higher priority", [tie?.unitPrice, tie?.sourcePricebookId], [8.5, 1]);

// Single book → its price, its id.
const single = matchPools(TERM, [bookA], [], false);
expect("single book match", [single?.unitPrice, single?.sourcePricebookId], [8.5, 1]);

// A book hit is FINAL: the HD cache must not override it even with fallback on.
const bookWins = matchPools(TERM, [bookA], hdCache, true);
expect("book hit is never overridden by HD", [bookWins?.unitPrice, bookWins?.fromHdCache], [8.5, false]);

// Miss + fallback on → HD cache prices it, with no book as the source.
const viaHd = matchPools("20A single pole circuit breaker", [], hdCache, true);
expect("fallback on: HD cache prices a miss", [viaHd?.unitPrice, viaHd?.fromHdCache, viaHd?.sourcePricebookId], [9.99, true, null]);

// Miss + fallback off → nothing, even though the HD cache has it (US5).
expect("fallback off: HD cache is invisible", matchPools(TERM, [], hdCache, false), null);

// Nothing anywhere → null (the unmatched flag downstream).
expect("total miss stays null", matchPools("3/4 in EMT conduit", [bookA], hdCache, true), null);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll collision checks passed");
