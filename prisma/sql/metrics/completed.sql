-- Speed, accuracy and value metrics, keyed on the bucket a quote was COMPLETED in.
--
-- $1 start timestamp, $2 end timestamp, $3 company ids (NULL = every company),
-- $4 global flag (collapse all tenants into pseudo-company 0), $5 bucket grain.
WITH params AS (
  SELECT $1::timestamp AS start_ts,
         $2::timestamp AS end_ts,
         $5::text       AS grain
),
buckets AS (
  SELECT generate_series(
           date_trunc((SELECT grain FROM params), (SELECT start_ts FROM params)),
           date_trunc((SELECT grain FROM params), (SELECT end_ts FROM params)),
           ('1 ' || (SELECT grain FROM params))::interval
         ) AS b
),
scopes AS (
  SELECT DISTINCT CASE WHEN $4::boolean THEN 0 ELSE company_id END AS scope_id
  FROM quotes
  WHERE ($3::int[] IS NULL OR company_id = ANY($3::int[]))
),
grid AS (SELECT s.scope_id, b.b FROM scopes s CROSS JOIN buckets b),
-- One row per completed quote with every fact the metrics need.
-- total_price is null on every line in this database, so line value is quantity * unit_price.
cq AS (
  SELECT q.id,
         CASE WHEN $4::boolean THEN 0 ELSE q.company_id END AS scope_id,
         date_trunc((SELECT grain FROM params), q.completed_at) AS b,
         EXTRACT(EPOCH FROM (q.completed_at - q.created_at)) AS secs,
         COALESCE(q.markup_percent, 0)   AS markup_percent,
         COALESCE(li.total_value, 0)     AS total_value,
         COALESCE(li.labor_value, 0)     AS labor_value,
         COALESCE(li.materials_value, 0) AS materials_value,
         COALESCE(li.line_count, 0)      AS line_count,
         COALESCE(li.price_edited_count, 0) AS price_edited_count,
         COALESCE(li.qty_edited_count, 0)   AS qty_edited_count,
         COALESCE(li.deleted_count, 0)      AS deleted_count,
         COALESCE(li.agent_line_count, 0)   AS agent_line_count,
         COALESCE(li.untouched_count, 0) AS untouched_count,
         COALESCE(li.edited_count, 0)    AS edited_count,
         COALESCE(li.manual_count, 0)    AS manual_count,
         COALESCE(li.labor_lines, 0)     AS labor_lines,
         COALESCE(img.n, 0)              AS image_count,
         (q.first_shared_at IS NOT NULL)  AS was_shared
  FROM quotes q
  LEFT JOIN LATERAL (
    -- Live lines carry everything the customer sees; removed lines are counted on their own
    -- so a deletion stays visible to the metric after the row stops being part of the quote.
    SELECT count(*) FILTER (WHERE deleted_at IS NULL)                             AS line_count,
           count(*) FILTER (WHERE deleted_at IS NULL AND NOT manually_edited)     AS untouched_count,
           count(*) FILTER (WHERE deleted_at IS NULL AND manually_edited)         AS edited_count,
           count(*) FILTER (WHERE deleted_at IS NULL AND NOT agent_suggested)     AS manual_count,
           count(*) FILTER (WHERE deleted_at IS NULL AND is_labor)                AS labor_lines,
           count(*) FILTER (WHERE deleted_at IS NULL AND price_edited_at IS NOT NULL)    AS price_edited_count,
           count(*) FILTER (WHERE deleted_at IS NULL AND quantity_edited_at IS NOT NULL) AS qty_edited_count,
           count(*) FILTER (WHERE deleted_at IS NOT NULL)                         AS deleted_count,
           count(*) FILTER (WHERE agent_suggested)                                AS agent_line_count,
           COALESCE(sum(quantity * unit_price) FILTER (WHERE deleted_at IS NULL), 0)                     AS total_value,
           COALESCE(sum(quantity * unit_price) FILTER (WHERE deleted_at IS NULL AND is_labor), 0)        AS labor_value,
           COALESCE(sum(quantity * unit_price) FILTER (WHERE deleted_at IS NULL AND NOT is_labor), 0)    AS materials_value
    FROM quote_line_items WHERE quote_id = q.id
  ) li ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS n FROM image_files f WHERE f.conversation_id = q.conversation_id
  ) img ON true
  WHERE q.status = 'COMPLETED'
    AND q.completed_at IS NOT NULL
    AND ($3::int[] IS NULL OR q.company_id = ANY($3::int[]))
)
SELECT g.scope_id AS company_id,
       g.b        AS period_start,
       m.metric_key,
       m.numerator,
       m.denominator,
       CASE WHEN m.denominator IS NULL THEN m.numerator
            WHEN m.denominator = 0 THEN NULL
            ELSE round(m.numerator::numeric / m.denominator, 6) END AS value
FROM grid g
CROSS JOIN LATERAL (
  SELECT
    (SELECT count(*) FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b)::numeric AS n_quotes,
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b) AS p50,
    (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY secs) FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b) AS p90,
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY markup_percent) FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b AND markup_percent > 0) AS med_markup,
    (SELECT sum(line_count)      FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b)::numeric AS lines_total,
    (SELECT sum(untouched_count) FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b)::numeric AS lines_untouched,
    (SELECT sum(edited_count)    FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b)::numeric AS lines_edited,
    (SELECT sum(manual_count)    FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b)::numeric AS lines_manual,
    (SELECT sum(total_value)     FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b)::numeric AS v_total,
    (SELECT sum(materials_value) FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b)::numeric AS v_materials,
    (SELECT sum(labor_value)     FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b)::numeric AS v_labor,
    (SELECT count(*) FILTER (WHERE labor_lines    > 0) FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b)::numeric AS n_with_labor,
    (SELECT count(*) FILTER (WHERE markup_percent > 0) FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b)::numeric AS n_with_markup,
    (SELECT count(*) FILTER (WHERE image_count    > 0) FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b)::numeric AS n_with_image,
    (SELECT count(*) FILTER (WHERE was_shared)         FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b)::numeric AS n_shared,
    (SELECT sum(price_edited_count) FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b)::numeric AS lines_price_edited,
    (SELECT sum(qty_edited_count)   FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b)::numeric AS lines_qty_edited,
    (SELECT sum(deleted_count)      FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b)::numeric AS lines_deleted,
    (SELECT sum(agent_line_count)   FROM cq WHERE cq.scope_id = g.scope_id AND cq.b = g.b)::numeric AS lines_agent
) f
CROSS JOIN LATERAL (
  VALUES
    ('quotes_completed',          f.n_quotes,        NULL::numeric),
    ('time_to_quote_p50_secs',    f.p50,             NULL::numeric),
    ('time_to_quote_p90_secs',    f.p90,             NULL::numeric),
    ('first_draft_accuracy',      f.lines_untouched, f.lines_total),
    ('line_edit_rate',            f.lines_edited,       f.lines_total),
    ('price_override_rate',       f.lines_price_edited, f.lines_total),
    ('quantity_edit_rate',        f.lines_qty_edited,   f.lines_total),
    -- The spec's denominator is lines the agent added, which is what agent_suggested is for.
    ('lines_deleted_rate',        f.lines_deleted,      f.lines_agent),
    ('manual_line_rate',          f.lines_manual,       f.lines_total),
    ('share_rate',                f.n_shared,           f.n_quotes),
    ('avg_quote_value',           f.v_total,         f.n_quotes),
    ('avg_materials_value',       f.v_materials,     f.n_quotes),
    ('avg_labor_value',           f.v_labor,         f.n_quotes),
    ('pct_quotes_with_labor',     f.n_with_labor,    f.n_quotes),
    ('markup_usage_rate',         f.n_with_markup,   f.n_quotes),
    ('median_markup_percent',     f.med_markup,      NULL::numeric),
    ('pct_quotes_with_image',     f.n_with_image,    f.n_quotes)
) AS m(metric_key, numerator, denominator)
WHERE f.n_quotes > 0
ORDER BY g.scope_id, g.b, m.metric_key;
