import assert from "assert";
import {
  bucketEnd,
  dropInProgressBucket,
  grainFor,
  summarize,
  truncateToGrain,
  WINDOW_METRICS,
} from "../src/api/services/metricsMath";
import { SeriesPoint } from "../src/api/services/metrics.types";

/**
 * Pins the metric arithmetic — the three ways a series collapses, and the bucket maths that
 * has to agree with Postgres date_trunc. Pure, no database.   npx tsx scripts/check-metrics.ts
 */

const p = (t: string, value: number | null, numerator: number | null = null, denominator: number | null = null): SeriesPoint =>
  ({ t, value, numerator, denominator });

// ---- summarize: counts sum -------------------------------------------------------------
assert.strictEqual(
  summarize("quotes_started", [p("2026-10-01", 3), p("2026-10-02", 4)]),
  7
);

// ---- summarize: a ratio is recomputed from the totals, never averaged -------------------
// 1/1 and 1/9 average to 0.555; the real rate over both buckets is 2/10.
assert.strictEqual(
  summarize("first_draft_accuracy", [
    p("2026-10-01", 1, 1, 1),
    p("2026-10-02", 1 / 9, 1, 9),
  ]),
  0.2
);

// An average weights by volume, not by bucket: a day with one quote must not count as much
// as a day with twenty.
assert.strictEqual(
  summarize("avg_quote_value", [
    p("2026-10-01", 100, 100, 1),
    p("2026-10-02", 50, 1000, 20),
  ]),
  1100 / 21
);

// ---- summarize: non-combinable metrics take the latest bucket with a value --------------
// Summing DAU across a week would count one technician seven times.
assert.strictEqual(summarize("dau", [p("2026-10-01", 5), p("2026-10-02", 3)]), 3);
// The median of daily medians is not the window's median.
assert.strictEqual(
  summarize("time_to_quote_p50_secs", [p("2026-10-01", 600), p("2026-10-02", 900)]),
  900
);
// A trailing empty bucket must not win — "latest" means latest that measured something.
assert.strictEqual(
  summarize("dau", [p("2026-10-01", 5), p("2026-10-02", null)]),
  5
);

// ---- summarize: nothing to divide by is null, not zero ---------------------------------
// This is lines_deleted_rate's exact shape while agent_suggested is false everywhere: a
// confident 0% reads as "nothing was deleted", which is a different claim from "unknown".
assert.strictEqual(summarize("lines_deleted_rate", [p("2026-10-01", null, 0, 0)]), null);
assert.strictEqual(summarize("first_draft_accuracy", []), null);

// ---- truncateToGrain: weeks are Monday-based, matching date_trunc('week', …) ------------
// Off by one day here puts the series one bucket away from what the SQL produced, which
// renders as missing data at one end rather than as an error.
assert.strictEqual(
  truncateToGrain(new Date("2026-10-14T13:45:00Z"), "week").toISOString(),
  "2026-10-12T00:00:00.000Z" // Wednesday → that Monday
);
assert.strictEqual(
  truncateToGrain(new Date("2026-10-18T23:59:59Z"), "week").toISOString(),
  "2026-10-12T00:00:00.000Z" // Sunday ends its week, it does not start the next
);
assert.strictEqual(
  truncateToGrain(new Date("2026-10-14T13:45:00Z"), "month").toISOString(),
  "2026-10-01T00:00:00.000Z"
);
assert.strictEqual(
  truncateToGrain(new Date("2026-10-14T13:45:00Z"), "day").toISOString(),
  "2026-10-14T00:00:00.000Z"
);
assert.strictEqual(
  truncateToGrain(new Date("2026-10-14T13:45:30Z"), "hour").toISOString(),
  "2026-10-14T13:00:00.000Z"
);

// ---- bucketEnd: one bucket forward, including uneven months ----------------------------
assert.strictEqual(
  bucketEnd(new Date("2026-10-12T00:00:00Z"), "week").toISOString(),
  "2026-10-19T00:00:00.000Z"
);
assert.strictEqual(
  bucketEnd(new Date("2026-02-01T00:00:00Z"), "month").toISOString(),
  "2026-03-01T00:00:00.000Z"
);
const start = new Date("2026-10-14T00:00:00Z");
bucketEnd(start, "day");
assert.strictEqual(start.toISOString(), "2026-10-14T00:00:00.000Z", "bucketEnd must not mutate");

// ---- grainFor: the window picks the bucket, so a short range is not one dot -------------
const days = (n: number) => ({
  from: new Date("2026-10-01T00:00:00Z"),
  to: new Date(new Date("2026-10-01T00:00:00Z").getTime() + n * 86_400_000),
});
const g = (n: number) => grainFor(days(n).from, days(n).to);
assert.strictEqual(g(1), "hour");
assert.strictEqual(g(2), "hour");
assert.strictEqual(g(3), "day");
assert.strictEqual(g(120), "day");
assert.strictEqual(g(121), "week");

// ---- dropInProgressBucket: a partial bucket must not become the headline ---------------
// DAU reports the most recent bucket, and the most recent bucket of a window ending now is
// almost always still running. At 09:00 that is a part-day compared against whole ones.
const dayPoints = [p("2026-10-13T00:00:00.000Z", 4), p("2026-10-14T00:00:00.000Z", 1)];
const midMorning = new Date("2026-10-14T09:00:00Z");
assert.strictEqual(dropInProgressBucket(dayPoints, "day", midMorning).length, 1);
assert.strictEqual(summarize("dau", dropInProgressBucket(dayPoints, "day", midMorning)), 4);
// Once the bucket has closed it counts normally.
const nextDay = new Date("2026-10-15T00:30:00Z");
assert.strictEqual(dropInProgressBucket(dayPoints, "day", nextDay).length, 2);
assert.strictEqual(summarize("dau", dropInProgressBucket(dayPoints, "day", nextDay)), 1);
// Nothing to drop is not an error.
assert.deepStrictEqual(dropInProgressBucket([], "day", midMorning), []);

// ---- WINDOW_METRICS: percentiles never come from the series ----------------------------
// The median of ninety daily medians is not the median of the ninety days, so these three
// are answered by window.sql instead of by collapsing buckets.
for (const k of ["time_to_quote_p50_secs", "time_to_quote_p90_secs", "median_markup_percent"])
  assert.ok(WINDOW_METRICS.has(k), `${k} must be answered over the window`);
assert.ok(!WINDOW_METRICS.has("quotes_completed"));

// ---- the "Today" preset must not block DAU ---------------------------------------------
// Today arrives as 00:00:00.000 -> 23:59:59.999, which is 0.99999 days. Compared raw against
// minDays 1 that blocked DAU on the one preset whose entire purpose is to show today.
const todayDays =
  (new Date("2026-10-14T23:59:59.999Z").getTime() - new Date("2026-10-14T00:00:00.000Z").getTime()) /
  86_400_000;
assert.ok(todayDays < 1, "the Today window really is under a day");
assert.ok(Math.ceil(todayDays) >= 1, "but it contains one whole day bucket");

console.log("ok   check-metrics: series collapsing + bucket arithmetic");
