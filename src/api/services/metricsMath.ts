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
 * Distinct-technician counts, which cannot be recombined across buckets: summing DAU across a
 * week counts one technician seven times. The most recent bucket carrying a value wins instead.
 * Percentiles are the same kind of metric but never reach summarize(); see WINDOW_METRICS.
 */
export const POINT_IN_TIME_METRICS = new Set(["dau", "wau", "mau"]);

/**
 * Metrics whose headline is computed over the whole window by window.sql, because no
 * arithmetic over the buckets can produce it. See that file for why.
 */
export const WINDOW_METRICS = new Set([
  "time_to_quote_p50_secs",
  "time_to_quote_p90_secs",
  "median_markup_percent",
]);

/** One calendar bucket as the card reads it, clipped to the selected window. */
export interface PeriodReading {
  value: number | null;
  /** First instant counted: the bucket start, or the window start if that is later. */
  start: string;
  /** Last instant counted: the bucket's last moment, or the as-of moment if that is earlier. */
  end: string;
  /** The bucket was still running at the as-of moment, so the value is "so far". */
  inProgress: boolean;
}

/**
 * The moment DAU, WAU and MAU are read at: the window end, or now if the window runs into
 * the future. "Today" arrives as 00:00 -> 23:59:59.999, so its end is usually hours ahead.
 */
export function asOfMoment(windowEnd: Date, now = new Date()): Date {
  return windowEnd.getTime() < now.getTime() ? windowEnd : now;
}

/**
 * The current bucket (the one holding the as-of moment) and the one before it.
 *
 * All three cards read the bucket that holds the SAME moment, so the day sits inside the
 * week and the week inside the month. The previous version took each metric's last COMPLETE
 * bucket instead, which on 20 Oct compared the week of 12 Oct against all of September — and
 * a growing tenant then showed more weekly than monthly technicians.
 *
 * A running bucket is shown as "so far" rather than dropped. The previous bucket rides along
 * so a quiet Monday morning (WAU 0 so far) still shows what last week looked like.
 */
export function periodReadings(
  series: SeriesPoint[],
  grain: MetricGrain,
  windowStart: Date,
  windowEnd: Date,
  now = new Date()
): { current: PeriodReading | null; previous: PeriodReading | null } {
  const asOf = asOfMoment(windowEnd, now);
  const byStart = new Map(series.map((p) => [new Date(p.t).getTime(), p]));

  const read = (bucketStart: Date): PeriodReading | null => {
    const point = byStart.get(bucketStart.getTime());
    if (!point) return null;
    const ends = bucketEnd(bucketStart, grain);
    const start = Math.max(bucketStart.getTime(), windowStart.getTime());
    const end = Math.min(ends.getTime() - 1, asOf.getTime());
    return {
      value: point.value,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      inProgress: ends.getTime() - 1 > asOf.getTime(),
    };
  };

  const currentStart = truncateToGrain(asOf, grain);
  const previousStart = truncateToGrain(new Date(currentStart.getTime() - 1), grain);
  return { current: read(currentStart), previous: read(previousStart) };
}

/** Buckets that start after the as-of moment have not happened yet; a chart must not draw them. */
export function dropFutureBuckets(series: SeriesPoint[], asOf: Date): SeriesPoint[] {
  return series.filter((p) => new Date(p.t).getTime() <= asOf.getTime());
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
