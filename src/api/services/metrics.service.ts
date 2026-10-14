import fs from "fs";
import path from "path";
import prisma from "../../lib/prisma";
import {
  FieldReadiness,
  FIXED_GRAIN_METRICS,
  GLOBAL_COMPANY_ID,
  METRIC_SECTIONS,
  MetricGrain,
  MetricRow,
  SeriesPoint,
} from "./metrics.types";
import { dropInProgressBucket, grainFor, summarize, WINDOW_METRICS } from "./metricsMath";

/**
 * Estimating Agent metrics.
 *
 * WHY THERE IS NO CACHE AND NO ROLLUP TABLE. Every metric here is a grouping over rows that
 * already carry their own timestamps — quotes, quote_line_items, conversations. Nothing is
 * ingested, so there is no moment at which the numbers "become" available and nothing to
 * schedule. A stored copy would only be a second version of what Postgres can already produce
 * on demand, which then has to be kept in step with the source, and it would answer with
 * yesterday's figures on the one page whose whole job is to say what is happening.
 *
 * The cost of being always current is two queries per request: a 90-day request measured
 * 0.165s on this branch. The service this replaced cached only day-or-week grains over
 * whole tenants — every short window, every hourly view and every hand-picked set of tenants
 * already computed live there.
 *
 * Worth knowing: history is recomputed, not frozen. Reopening and re-completing a quote moves
 * its own past time-to-quote, because the metric always reflects current truth.
 *
 * Watch for: completed.sql runs ~21 correlated subqueries per bucket, so cost grows with
 * buckets x rows, not rows alone. If a 12-month view ever drags, the answer is a single-pass
 * rewrite of that query or a materialized rollup — not a cache in front of the current shape.
 */

type RawMetricRow = {
  company_id: number;
  period_start: Date;
  metric_key: string;
  numerator: unknown;
  denominator: unknown;
  value: unknown;
};

export interface MetricSeriesResult {
  key: string;
  grain: MetricGrain;
  blocked: boolean;
  reason?: string;
  series: SeriesPoint[];
  current: number | null;
  companions?: { key: string; current: number | null }[];
  breakdown?: { companyId: number; name: string; value: number | null }[];
}

export class MetricsService {
  private sqlCache = new Map<string, string>();

  /**
   * SQL lives in prisma/sql/metrics so the metric definitions are reviewable on their own,
   * rather than buried in template literals. Read once per process. The Dockerfile copies
   * ./prisma into the runtime image and the server runs from /app, so this path resolves in
   * the container exactly as it does locally.
   */
  private loadSql(name: string): string {
    const cached = this.sqlCache.get(name);
    if (cached) return cached;
    const file = path.resolve(process.cwd(), "prisma", "sql", "metrics", `${name}.sql`);
    const sql = fs.readFileSync(file, "utf-8");
    this.sqlCache.set(name, sql);
    return sql;
  }

  /** Postgres numerics arrive as strings or Decimal; everything downstream wants a number. */
  private toNumber(v: unknown): number | null {
    if (v === null || v === undefined) return null;
    const n = typeof v === "number" ? v : Number(v.toString());
    return Number.isFinite(n) ? n : null;
  }

  static grainFor = grainFor;

  /**
   * Run both metric queries.
   *
   * `global` collapses every tenant into pseudo-company 0. With it false and no company ids,
   * the same query returns one row set per company — which is how the per-tenant breakdown is
   * built in one pass instead of one query per company.
   */
  private async runQueries(params: {
    startDate: Date;
    endDate: Date;
    companyIds: number[] | null;
    global: boolean;
    grain: MetricGrain;
  }): Promise<MetricRow[]> {
    const out: MetricRow[] = [];
    for (const name of ["adoption", "completed"]) {
      const raw = await prisma.$queryRawUnsafe<RawMetricRow[]>(
        this.loadSql(name),
        params.startDate,
        params.endDate,
        params.companyIds,
        params.global,
        params.grain
      );
      for (const r of raw) {
        out.push({
          company_id: Number(r.company_id),
          metric_key: r.metric_key,
          period_start: new Date(r.period_start).toISOString(),
          value: this.toNumber(r.value),
          numerator: this.toNumber(r.numerator),
          denominator: this.toNumber(r.denominator),
        });
      }
    }
    return out;
  }

  /**
   * Whole-window values for the metrics a bucket series cannot answer.
   *
   * Returns metric_key -> value for one scope. Percentiles are not additive, so the headline
   * has to be computed over the period rather than picked out of the series.
   */
  private async runWindowQuery(params: {
    startDate: Date;
    endDate: Date;
    companyIds: number[] | null;
    global: boolean;
  }): Promise<Map<number, Map<string, number | null>>> {
    const raw = await prisma.$queryRawUnsafe<
      { company_id: number; metric_key: string; value: unknown }[]
    >(
      this.loadSql("window"),
      params.startDate,
      params.endDate,
      params.companyIds,
      params.global
    );
    const out = new Map<number, Map<string, number | null>>();
    for (const r of raw) {
      const scope = Number(r.company_id);
      const m = out.get(scope) ?? new Map<string, number | null>();
      m.set(r.metric_key, this.toNumber(r.value));
      out.set(scope, m);
    }
    return out;
  }

  /** Group rows into one sorted series per metric key. */
  private toSeries(rows: MetricRow[]): Map<string, SeriesPoint[]> {
    const byMetric = new Map<string, SeriesPoint[]>();
    for (const r of rows) {
      const list = byMetric.get(r.metric_key) ?? [];
      list.push({
        t: r.period_start,
        value: r.value,
        numerator: r.numerator,
        denominator: r.denominator,
      });
      byMetric.set(r.metric_key, list);
    }
    for (const list of byMetric.values()) list.sort((a, b) => a.t.localeCompare(b.t));
    return byMetric;
  }

  /**
   * Read a series per metric for the requested filter.
   *
   * The bucket grid comes out of the SQL, which generates a complete series across the window
   * at each metric's own bucket. A quiet day is therefore a zero rather than a gap: a chart
   * drawn from only the active buckets misreads inactivity as missing data and compresses an
   * empty fortnight into a single step.
   */
  async getSeries(params: {
    startDate: Date;
    endDate: Date;
    companyIds?: number[];
    grain: MetricGrain;
  }) {
    const ids = params.companyIds?.length ? params.companyIds : undefined;
    const isAll = ids === undefined;
    const windowDays = (params.endDate.getTime() - params.startDate.getTime()) / 86_400_000;

    const [rows, windowValues, readiness] = await Promise.all([
      this.runQueries({
        startDate: params.startDate,
        endDate: params.endDate,
        companyIds: ids ?? null,
        global: true,
        grain: params.grain,
      }),
      this.runWindowQuery({
        startDate: params.startDate,
        endDate: params.endDate,
        companyIds: ids ?? null,
        global: true,
      }),
      this.fieldReadiness(),
    ]);

    const windowGlobal = windowValues.get(GLOBAL_COMPANY_ID) ?? new Map<string, number | null>();
    const byMetric = this.toSeries(rows);

    // A split is only meaningful when the number covers more than one tenant. A single
    // selected company already is its own breakdown.
    const breakdown =
      isAll || (ids?.length ?? 0) > 1
        ? await this.buildBreakdown({
            startDate: params.startDate,
            endDate: params.endDate,
            companyIds: ids ?? null,
            grain: params.grain,
          })
        : {};

    /**
     * The one number a card shows.
     *
     * Three sources, because three kinds of metric collapse differently: a percentile comes
     * from the window query, a per-calendar-bucket count from its last COMPLETE bucket, and
     * everything else from the series totals.
     */
    const headline = (key: string, series: SeriesPoint[], grain: MetricGrain) => {
      if (WINDOW_METRICS.has(key)) return windowGlobal.get(key) ?? null;
      if (FIXED_GRAIN_METRICS[key]) return summarize(key, dropInProgressBucket(series, grain));
      return summarize(key, series);
    };

    const sections: Record<string, MetricSeriesResult[]> = {};

    for (const [section, defs] of Object.entries(METRIC_SECTIONS)) {
      sections[section] = defs.map((def): MetricSeriesResult => {
        // A window shorter than the metric's own bucket cannot express it. Say so, rather
        // than drawing a partial bucket that looks like a complete one.
        //
        // Measured in whole days, not a fraction of one. "Today" arrives as 00:00:00.000 to
        // 23:59:59.999, which is 0.99999 days — against a raw `< 1` that blocked DAU on the
        // one preset whose entire purpose is to show today.
        const fixed = FIXED_GRAIN_METRICS[def.key];
        if (fixed && Math.ceil(windowDays) < fixed.minDays) {
          const unit = fixed.minDays === 1 ? "day" : "days";
          return {
            key: def.key,
            blocked: true,
            reason: `Needs at least ${fixed.minDays} ${unit} in the selected period — this metric counts technicians per ${fixed.grain}.`,
            series: [],
            current: null,
            grain: fixed.grain,
          };
        }

        const missing = (def.requires ?? []).filter((field) => !readiness[field]);
        if (missing.length > 0) {
          return {
            key: def.key,
            blocked: true,
            reason: def.pendingReason ?? "Source field is not populated yet.",
            series: [],
            current: null,
            grain: fixed?.grain ?? params.grain,
          };
        }

        const series = byMetric.get(def.key) ?? [];
        return {
          key: def.key,
          blocked: false,
          // Each metric reports the bucket its own points sit on, so a monthly count is never
          // labelled as whatever grain the rest of the page is using.
          grain: fixed?.grain ?? params.grain,
          breakdown: breakdown[def.key] ?? [],
          // numerator/denominator travel with every point so the detail table can show the
          // counts behind a ratio, not just the ratio.
          series,
          current: headline(def.key, series, fixed?.grain ?? params.grain),
          companions: (def.companions ?? []).map((ck) => ({
            key: ck,
            current: headline(
              ck,
              byMetric.get(ck) ?? [],
              FIXED_GRAIN_METRICS[ck]?.grain ?? params.grain
            ),
          })),
        };
      });
    }

    return { sections, grain: params.grain, generatedAt: new Date().toISOString() };
  }

  /**
   * Per-company contribution to each metric.
   *
   * One query for every tenant at once — the same SQL with the global flag off returns rows
   * already keyed by company_id. Each company is then summarised with the same rules as the
   * headline number, which is why a ratio here is recomputed from that company's own
   * numerator and denominator rather than averaged.
   *
   * Consequence the page states for the reader: counts add up to the total, rates and
   * averages do not, because the overall figure is weighted by volume.
   */
  private async buildBreakdown(params: {
    startDate: Date;
    endDate: Date;
    companyIds: number[] | null;
    grain: MetricGrain;
  }): Promise<Record<string, { companyId: number; name: string; value: number | null }[]>> {
    const [rows, windowByCompany, companies] = await Promise.all([
      this.runQueries({
        startDate: params.startDate,
        endDate: params.endDate,
        companyIds: params.companyIds,
        global: false,
        grain: params.grain,
      }),
      this.runWindowQuery({
        startDate: params.startDate,
        endDate: params.endDate,
        companyIds: params.companyIds,
        global: false,
      }),
      this.listCompanies(),
    ]);

    const names = new Map(companies.map((c) => [c.id, c.name]));

    const byCompany = new Map<number, MetricRow[]>();
    for (const r of rows) {
      if (r.company_id === GLOBAL_COMPANY_ID) continue;
      const list = byCompany.get(r.company_id) ?? [];
      list.push(r);
      byCompany.set(r.company_id, list);
    }

    const out: Record<string, { companyId: number; name: string; value: number | null }[]> = {};

    for (const [companyId, companyRows] of byCompany) {
      const win = windowByCompany.get(companyId);
      for (const [key, series] of this.toSeries(companyRows)) {
        // Same three collapse rules as the headline, so a company's row never disagrees with
        // the total it is supposed to explain.
        const value = WINDOW_METRICS.has(key)
          ? win?.get(key) ?? null
          : FIXED_GRAIN_METRICS[key]
            ? summarize(key, dropInProgressBucket(series, FIXED_GRAIN_METRICS[key].grain))
            : summarize(key, series);
        if (value === null) continue;
        out[key] = out[key] ?? [];
        out[key].push({
          companyId,
          name: names.get(companyId) ?? `Company ${companyId}`,
          value,
        });
      }
    }

    // Busiest first — the question this answers is "who is driving this number".
    for (const key of Object.keys(out)) {
      out[key].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    }

    return out;
  }

  /**
   * Which metric source fields have ever been written.
   *
   * phase19 adds the columns and their writers land with it, but historical rows carry
   * nothing. Until a column holds at least one value every metric over it computes a
   * confident zero that reads exactly like a real measurement — so this check decides whether
   * a row shows a number or says what is still missing.
   */
  async fieldReadiness(): Promise<FieldReadiness> {
    const rows = await prisma.$queryRawUnsafe<FieldReadiness[]>(`
      SELECT
        EXISTS (SELECT 1 FROM quote_line_items WHERE price_edited_at    IS NOT NULL) AS price_edited,
        EXISTS (SELECT 1 FROM quote_line_items WHERE quantity_edited_at IS NOT NULL) AS quantity_edited,
        EXISTS (SELECT 1 FROM quote_line_items_deleted)                              AS line_deleted,
        EXISTS (SELECT 1 FROM quote_line_items WHERE agent_suggested)                AS agent_suggested,
        EXISTS (SELECT 1 FROM quotes           WHERE origin             IS NOT NULL) AS quote_origin,
        EXISTS (SELECT 1 FROM quotes           WHERE first_shared_at    IS NOT NULL) AS quote_shared
    `);

    return (
      rows[0] ?? {
        price_edited: false,
        quantity_edited: false,
        line_deleted: false,
        agent_suggested: false,
        quote_origin: false,
        quote_shared: false,
      }
    );
  }

  /**
   * Every company, with how many quotes it has.
   *
   * A left join on purpose: a tenant with no estimating activity yet is a real answer the
   * filter should be able to give, and the count beside each name says which is which.
   */
  async listCompanies(): Promise<{ id: number; name: string; quotes: number }[]> {
    return prisma.$queryRawUnsafe<{ id: number; name: string; quotes: number }[]>(
      `SELECT c.id::int AS id, c.name AS name, count(q.id)::int AS quotes
         FROM companies c
         LEFT JOIN quotes q ON q.company_id = c.id
        GROUP BY c.id, c.name
        ORDER BY count(q.id) DESC, c.name ASC`
    );
  }
}

export const metricsService = new MetricsService();
