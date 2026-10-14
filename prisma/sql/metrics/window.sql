-- Whole-window values for the metrics that cannot be recombined from buckets.
--
-- $1 start timestamp, $2 end timestamp, $3 company ids (NULL = every company),
-- $4 global flag (collapse all tenants into pseudo-company 0).
--
-- A percentile is not additive: the median of ninety daily medians is not the median of the
-- ninety days, and there is no arithmetic that recovers one from the other. The series in
-- completed.sql is still per-bucket, which is what the chart needs — this computes the single
-- number the card shows, over the window as a whole.
--
-- Without it the headline falls back to "the last bucket that had a value", so a card labelled
-- "Time to quote, last 90 days" would report the median of whichever recent day happened to
-- contain a completion. One slow afternoon becomes the quarter's figure.
--
-- The window is applied to completed_at directly rather than through a bucket grid: this is one
-- answer for the period, so there is nothing to align to a bucket boundary.
WITH cq AS (
  SELECT CASE WHEN $4::boolean THEN 0 ELSE q.company_id END AS scope_id,
         EXTRACT(EPOCH FROM (q.completed_at - q.created_at)) AS secs,
         COALESCE(q.markup_percent, 0) AS markup_percent
  FROM quotes q
  WHERE q.status = 'COMPLETED'
    AND q.completed_at IS NOT NULL
    AND q.completed_at >= $1::timestamp
    AND q.completed_at <= $2::timestamp
    AND ($3::int[] IS NULL OR q.company_id = ANY($3::int[]))
)
SELECT scope_id AS company_id,
       m.metric_key,
       m.value
FROM (SELECT DISTINCT scope_id FROM cq) s
CROSS JOIN LATERAL (
  VALUES
    ('time_to_quote_p50_secs',
     (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) FROM cq WHERE cq.scope_id = s.scope_id)),
    ('time_to_quote_p90_secs',
     (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY secs) FROM cq WHERE cq.scope_id = s.scope_id)),
    -- Median of the quotes that actually carry a markup. Including the zeros would report the
    -- median of "did anyone set a markup", which markup_usage_rate already answers.
    ('median_markup_percent',
     (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY markup_percent)
        FROM cq WHERE cq.scope_id = s.scope_id AND markup_percent > 0))
) AS m(metric_key, value)
ORDER BY 1, 2;
