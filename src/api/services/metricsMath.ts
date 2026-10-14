import { MetricGrain, SeriesPoint } from "./metrics.types";

/**
 * Bucket arithmetic and series collapsing. Pure — no Prisma, no I/O — so
 * scripts/check-metrics.ts can pin it without a database.
 */

/** End of the bucket that starts at `start` — exclusive. */
export function bucketEnd(start: Date, grain: MetricGrain): Date {
  const d = new Date(start);
  if (grain === "month") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (grain === "week") d.setUTCDate(d.getUTCDate() + 7);
  else if (grain === "day") d.setUTCDate(d.getUTCDate() + 1);
  else d.setUTCHours(d.getUTCHours() + 1);
  return d;
}

/** Start of the bucket a timestamp falls in, matching Postgres date_trunc. */
export function truncateToGrain(date: Date, grain: MetricGrain): Date {
  const d = new Date(date);
  if (grain === "month") {
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  if (grain === "week") {
    // Monday-based, as date_trunc('week', …) is. Getting this wrong puts the series one day
    // off the buckets the SQL produced, which looks like missing data at one end.
    const day = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  if (grain === "day") {
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/**
 * Pick a bucket size that gives a readable number of points for the window.
 *
 * A one-day window read by day is a single dot, which is why the grain follows the filter
 * rather than being fixed.
 */
export function grainFor(startDate: Date, endDate: Date): MetricGrain {
  const days = (endDate.getTime() - startDate.getTime()) / 86_400_000;
  if (days <= 2) return "hour";
  if (days <= 120) return "day";
  return "week";
}

/** Metrics whose buckets add up. */
export const COUNT_METRICS = new Set(["quotes_started", "quotes_completed"]);

/**
 * Metrics that cannot be recombined across buckets at all. A distinct-technician count and a
 * percentile are both meaningless when added or averaged — the median of seven daily medians
 * is not the week's median, and summing DAU across a week counts one technician seven times.
 * The most recent bucket carrying a value wins instead.
 */
export const POINT_IN_TIME_METRICS = new Set([
  "dau",
  "wau",
  "mau",
  "time_to_quote_p50_secs",
  "time_to_quote_p90_secs",
  "median_markup_percent",
]);

/**
 * Metrics whose headline is computed over the whole window by window.sql, because no
 * arithmetic over the buckets can produce it. See that file for why.
 */
export const WINDOW_METRICS = new Set([
  "time_to_quote_p50_secs",
  "time_to_quote_p90_secs",
  "median_markup_percent",
]);

/**
 * Drop a trailing bucket that has not finished yet.
 *
 * DAU, WAU and MAU report the most recent bucket, and the most recent bucket of a window
 * ending now is almost always in progress. At 09:00 that is a partial day being compared
 * against complete ones — a headline that climbs through the day and reads 0 every morning.
 * The last COMPLETE bucket is the honest answer; if none has completed, there is none.
 */
export function dropInProgressBucket(
  series: SeriesPoint[],
  grain: MetricGrain,
  now = new Date()
): SeriesPoint[] {
  if (series.length === 0) return series;
  const last = series[series.length - 1];
  const ends = bucketEnd(new Date(last.t), grain);
  return ends.getTime() > now.getTime() ? series.slice(0, -1) : series;
}

/**
 * Collapse a series into the one number the card shows.
 *
 * Three kinds of metric collapse three different ways, and using the wrong one is the classic
 * way a dashboard lies: counts sum; ratios and averages are recomputed from the numerator and
 * denominator totals, because averaging daily averages weights a day with one quote the same
 * as a day with twenty; distinct-user counts and percentiles are not combinable at all.
 */
export function summarize(key: string, series: SeriesPoint[]): number | null {
  const withValues = series.filter((p) => p.value !== null);
  if (withValues.length === 0) return null;

  if (COUNT_METRICS.has(key)) {
    return withValues.reduce((sum, p) => sum + (p.value ?? 0), 0);
  }
  if (POINT_IN_TIME_METRICS.has(key)) {
    return withValues[withValues.length - 1].value;
  }

  const numerator = series.reduce((sum, p) => sum + (p.numerator ?? 0), 0);
  const denominator = series.reduce((sum, p) => sum + (p.denominator ?? 0), 0);
  if (denominator === 0) return null;
  return numerator / denominator;
}
