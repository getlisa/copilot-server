-- Adoption metrics, one row per (company, bucket, metric_key).
--
-- $1 start timestamp, $2 end timestamp, $3 company ids (NULL = every company),
-- $4 global flag (collapse all tenants into pseudo-company 0), $5 bucket grain
-- ('hour' | 'day' | 'week').
--
-- The grain is a real parameter rather than a fixed day, so a one-day window can be read
-- hour by hour and a year can be read by week without changing the metric definitions.
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
scoped_quotes AS (
  SELECT q.*,
         CASE WHEN $4::boolean THEN 0 ELSE q.company_id END AS scope_id
  FROM quotes q
  WHERE ($3::int[] IS NULL OR q.company_id = ANY($3::int[]))
),
scopes AS (SELECT DISTINCT scope_id FROM scoped_quotes),
grid AS (SELECT s.scope_id, b.b FROM scopes s CROSS JOIN buckets b),
-- An estimating chat is a conversation with no job attached: job chats carry a job_id, the
-- estimating agent's do not.
--
-- Deliberately NOT "a conversation a quote references". These metrics count technicians who
-- *started a chat*, so a chat abandoned before it produced a quote still counts — that is a
-- technician who showed up. In this database 45 chats exist against 44 quotes, so the quote
-- rule silently dropped one.
--
-- Company comes from the user rather than the quote, because a chat without a quote has no
-- other route to a tenant.
est_chat AS (
  SELECT DISTINCT
         CASE WHEN $4::boolean THEN 0 ELSE u.company_id END AS scope_id,
         c.user_id,
         c.created_at AS at
  FROM conversations c
  JOIN users u ON u.id = c.user_id
  WHERE c.job_id IS NULL
    AND ($3::int[] IS NULL OR u.company_id = ANY($3::int[]))
),
-- Active-technician counts are calendar buckets, each at its own size: a day for DAU, a week
-- for WAU, a month for MAU. The spec lists them as three rows precisely because they are
-- three bucket sizes, not one metric viewed three ways.
--
-- An earlier version counted a rolling window ending at each day. That read activity from
-- outside the selected period, and made the number fall as users aged out of the window.
active_counts AS (
  SELECT 'dau' AS metric_key, scope_id,
         date_trunc('day', at) AS b, count(DISTINCT user_id)::numeric AS n
  FROM est_chat GROUP BY 1, 2, 3
  UNION ALL
  SELECT 'wau', scope_id, date_trunc('week', at), count(DISTINCT user_id)::numeric
  FROM est_chat GROUP BY 1, 2, 3
  UNION ALL
  SELECT 'mau', scope_id, date_trunc('month', at), count(DISTINCT user_id)::numeric
  FROM est_chat GROUP BY 1, 2, 3
),
-- A complete bucket grid per metric, so a quiet day is a zero rather than a gap. A sparkline
-- drawn from only the active buckets misreads inactivity as missing data, and compresses an
-- empty fortnight into a single step.
active_grid AS (
  SELECT 'dau' AS metric_key, s.scope_id, gs AS b
  FROM scopes s CROSS JOIN generate_series(
    date_trunc('day',  (SELECT start_ts FROM params)),
    date_trunc('day',  (SELECT end_ts   FROM params)), interval '1 day') gs
  UNION ALL
  SELECT 'wau', s.scope_id, gs
  FROM scopes s CROSS JOIN generate_series(
    date_trunc('week', (SELECT start_ts FROM params)),
    date_trunc('week', (SELECT end_ts   FROM params)), interval '1 week') gs
  UNION ALL
  SELECT 'mau', s.scope_id, gs
  FROM scopes s CROSS JOIN generate_series(
    date_trunc('month',(SELECT start_ts FROM params)),
    date_trunc('month',(SELECT end_ts   FROM params)), interval '1 month') gs
),
active_users AS (
  SELECT g.metric_key, g.scope_id, g.b, COALESCE(c.n, 0) AS n
  FROM active_grid g
  LEFT JOIN active_counts c
    ON c.metric_key = g.metric_key AND c.scope_id = g.scope_id AND c.b = g.b
),
started AS (
  SELECT scope_id,
         date_trunc((SELECT grain FROM params), created_at) AS b,
         count(*) AS n,
         count(*) FILTER (WHERE status = 'COMPLETED') AS n_completed,
         -- Denominator is quotes that carry an origin at all: rows predating the column are
         -- unknown, not manual, and counting them as manual would overstate manual starts.
         count(*) FILTER (WHERE origin IS NOT NULL)   AS n_with_origin,
         count(*) FILTER (WHERE origin = 'crm')       AS n_crm
  FROM scoped_quotes
  GROUP BY 1, 2
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
  VALUES
    ('quotes_started',
     COALESCE((SELECT n FROM started s WHERE s.scope_id = g.scope_id AND s.b = g.b), 0)::numeric,
     NULL::numeric),
    ('start_to_completed_rate',
     COALESCE((SELECT n_completed FROM started s WHERE s.scope_id = g.scope_id AND s.b = g.b), 0)::numeric,
     COALESCE((SELECT n FROM started s WHERE s.scope_id = g.scope_id AND s.b = g.b), 0)::numeric),
    ('crm_vs_manual_share',
     COALESCE((SELECT n_crm FROM started s WHERE s.scope_id = g.scope_id AND s.b = g.b), 0)::numeric,
     COALESCE((SELECT n_with_origin FROM started s WHERE s.scope_id = g.scope_id AND s.b = g.b), 0)::numeric)
) AS m(metric_key, numerator, denominator)

UNION ALL

-- Each active-user row carries its own bucket start, so a monthly count is never drawn as if
-- it were a daily one.
SELECT a.scope_id AS company_id,
       a.b        AS period_start,
       a.metric_key,
       a.n        AS numerator,
       NULL::numeric AS denominator,
       a.n        AS value
FROM active_users a
-- The grid already spans exactly the window at each metric's own bucket, truncated to the
-- bucket start so a window opening mid-month still carries that month.

ORDER BY 1, 2, 3;
