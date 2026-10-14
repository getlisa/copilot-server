/**
 * Metric vocabulary, shared between the service and the pure arithmetic module.
 *
 * Kept separate so `metricsMath.ts` can be imported by scripts/check-metrics.ts without
 * dragging in Prisma, and so neither module has to import the other.
 */

/** Bucket size a series is computed at. */
export type MetricGrain = "hour" | "day" | "week" | "month";

/** One (company, bucket, metric) row as the SQL returns it, after number coercion. */
export interface MetricRow {
  company_id: number;
  metric_key: string;
  /** ISO timestamp of the bucket start. */
  period_start: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
}

/** One point of a metric's series. Same fields as MetricRow, without the scope. */
export interface SeriesPoint {
  t: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
}

/**
 * Metrics that ignore the page's grain and always use their own calendar bucket.
 *
 * "Technicians who created at least one new chat in a week" is a per-week count. Rendering it
 * at whatever grain the page happens to use would either repeat the same figure across days
 * or, worse, count a rolling window that reaches outside the selected period.
 */
export const FIXED_GRAIN_METRICS: Record<string, { grain: MetricGrain; minDays: number }> = {
  dau: { grain: "day", minDays: 1 },
  wau: { grain: "week", minDays: 7 },
  // 28, the shortest month — a window below that cannot express a monthly count.
  mau: { grain: "month", minDays: 28 },
};

/**
 * Pseudo-company holding the cross-tenant rollup. Real company ids start at 1, so 0 is free
 * and keeps the all-tenant series in the same shape as every other series.
 */
export const GLOBAL_COMPANY_ID = 0;

/**
 * Whether each metric source field has ever been written.
 *
 * phase18 adds the columns; the writers land with it. Until a column actually carries data
 * every metric over it would compute a confident zero, which reads exactly like a real
 * measurement — so this decides whether a row shows a number or says what is missing.
 */
export interface FieldReadiness {
  price_edited: boolean;
  quantity_edited: boolean;
  line_deleted: boolean;
  agent_suggested: boolean;
  quote_origin: boolean;
  quote_shared: boolean;
}

/**
 * The product spec's four sections, in its order, using its own metric names.
 *
 * Some spec rows carry two readings ("Time-to-quote: median and slowest 10%", "Markup usage
 * rate and median markup", "Average quote value, split into materials and labor"). Those are
 * one card with a companion key rather than separate rows, so the page matches the document.
 */
export interface MetricDef {
  key: string;
  /** Extra keys the same card displays alongside the main reading. */
  companions?: string[];
  /** Source fields this row needs populated before its number means anything. */
  requires?: (keyof FieldReadiness)[];
  /** What is missing, when `requires` is not satisfied. */
  pendingReason?: string;
}

export const METRIC_SECTIONS: Record<string, MetricDef[]> = {
  adoption: [
    { key: "dau" },
    { key: "wau" },
    { key: "mau" },
    { key: "quotes_started" },
    { key: "start_to_completed_rate" },
    {
      key: "crm_vs_manual_share",
      requires: ["quote_origin"],
      pendingReason:
        "quotes.origin exists but no quote carries one yet. Quote creation stamps crm or manual from phase18 onward; rows created before that stay unknown and are counted in neither bucket.",
    },
  ],
  speed: [{ key: "time_to_quote_p50_secs", companions: ["time_to_quote_p90_secs"] }],
  accuracy: [
    { key: "first_draft_accuracy" },
    {
      key: "price_override_rate",
      requires: ["price_edited"],
      pendingReason:
        "quote_line_items.price_edited_at exists but nothing has set it yet. The price endpoint stamps it on the first edit of a line.",
    },
    {
      key: "quantity_edit_rate",
      requires: ["quantity_edited"],
      pendingReason:
        "quote_line_items.quantity_edited_at exists but nothing has set it yet. The line PATCH stamps it on the first quantity change.",
    },
    {
      key: "lines_deleted_rate",
      requires: ["line_deleted", "agent_suggested"],
      pendingReason:
        "Needs soft delete writing deleted_at instead of removing the row, and agent_suggested set on agent-created lines. Its denominator is lines the agent added, so with agent_suggested false everywhere this divides by zero.",
    },
    {
      key: "manual_line_rate",
      requires: ["agent_suggested"],
      pendingReason:
        "quote_line_items.agent_suggested is false on every row, so this would report 100% manual.",
    },
  ],
  value: [
    { key: "avg_quote_value", companions: ["avg_materials_value", "avg_labor_value"] },
    { key: "pct_quotes_with_labor" },
    { key: "markup_usage_rate", companions: ["median_markup_percent"] },
    { key: "pct_quotes_with_image" },
    {
      key: "share_rate",
      requires: ["quote_shared"],
      pendingReason:
        "quotes.first_shared_at exists but nothing has set it yet. The email, docx and pdf endpoints stamp it on the first successful send.",
    },
  ],
};
