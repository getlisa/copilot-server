-- Phase 19: record removed line items instead of counting them, so "Line items deleted" has
-- something to measure (product metrics spec, 2026-10-14).
--
-- A removed line is a fact about how good the agent's first draft was, and a plain DELETE
-- throws it away. Three designs were weighed:
--
--   soft delete  — keep the row, mark it. Rejected: every read of quote_line_items then has to
--                  filter it out, and a single missed filter puts a line the technician
--                  deliberately removed back onto a customer's proposal or onto the estimate
--                  posted into their QuickBooks. Six read sites, silent failure, no error.
--   counters     — keep the hard delete, increment a tally on the quote. Safe to read, but the
--                  tally cannot be recomputed if it ever desyncs, and it can never answer which
--                  lines were deleted, only how many.
--   this         — hard delete, and move the row here in the same statement. The line genuinely
--                  leaves quote_line_items, so NO read path changes and nothing can leak. The
--                  metric stays a COUNT over rows like every other metric on the page, and the
--                  whole row is kept for the question that comes next: are technicians deleting
--                  the expensive material lines the agent guessed at?
--
-- Additive and idempotent; runs via docs/sql/apply-phase19.sh — never prisma migrate.
-- ORDER: run BEFORE the image that writes it deploys. Requires phase18.

CREATE TABLE IF NOT EXISTS public.quote_line_items_deleted (
  -- The ORIGINAL line's id, as the primary key. This is what makes the write idempotent: a
  -- statement retried after an ambiguous failure cannot archive the same line twice, because
  -- the database refuses the duplicate. A counter has no equivalent protection — a second
  -- increment is a legal operation that produces a wrong number and leaves no trace.
  id              TEXT PRIMARY KEY,
  quote_id        TEXT NOT NULL,
  -- Denormalised from the row being removed so the metric never has to open the snapshot.
  -- agent_suggested is the one that matters: the rate's denominator is lines the agent
  -- proposed, and a deleted line has to be added back to it or the deletion is counted twice —
  -- once in the numerator, once as a missing proposal. 3 of 10 would read as 3 of 7.
  agent_suggested BOOLEAN NOT NULL DEFAULT false,
  is_labor        BOOLEAN NOT NULL DEFAULT false,
  quantity        NUMERIC(12, 2),
  unit_price      NUMERIC(12, 2),
  deleted_at      TIMESTAMP(6) NOT NULL DEFAULT now(),
  deleted_by      BIGINT,
  -- The whole original row. Typed columns above are what the metrics query; this is what keeps
  -- the record complete when quote_line_items gains a column this table does not have.
  snapshot        JSONB NOT NULL
);

-- Deliberately NO foreign key to quotes. quote_line_items cascades from quotes, so a deleted
-- quote takes its lines with it; an FK here would do the same to the history. The metric is
-- unaffected either way (it buckets on quotes.completed_at, which is gone too), so this exists
-- purely so an audit still has something to read.
CREATE INDEX IF NOT EXISTS quote_line_items_deleted_quote_id_idx
  ON public.quote_line_items_deleted (quote_id);
CREATE INDEX IF NOT EXISTS quote_line_items_deleted_deleted_at_idx
  ON public.quote_line_items_deleted (deleted_at);

COMMENT ON TABLE public.quote_line_items_deleted IS
  'Line items removed from a draft quote. Written by the same statement that deletes the row.';

-- phase18 added deleted_at/deleted_by to quote_line_items for the soft-delete design that this
-- phase replaces. Nothing ever wrote them — verified 0 of 113 rows — so dropping them now costs
-- nothing, and leaving them would leave two contradictory ways to express "this line was
-- removed". Dropping deleted_at also drops the partial index built on it; the plain (quote_id)
-- index that every quote load actually uses is declared on the model and stays.
ALTER TABLE public.quote_line_items DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE public.quote_line_items DROP COLUMN IF EXISTS deleted_by;
