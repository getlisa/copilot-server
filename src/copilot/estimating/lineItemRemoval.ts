import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import logger from "../../lib/logger";

/**
 * Removing a line item: delete the row AND record it, in one statement.
 *
 * WHY THIS EXISTS
 *
 * "Line items deleted" asks how many of the lines the agent proposed a technician threw away —
 * a direct reading of how good the first draft was. A plain DELETE destroys the only evidence,
 * so the metric cannot be computed at all.
 *
 * Three designs were weighed (see docs/sql/phase19.sql). The one NOT taken is worth knowing:
 * soft delete, where the row stays and carries a `deleted_at`. It fails on the read side. Line
 * items are not internal data — they are what prints on the customer's proposal and what posts
 * into their QuickBooks, ZenTrades, Uptick, ServiceTrade and Housecall Pro. Every one of those
 * reads would need `deleted_at IS NULL`, and a single missed filter puts a line the technician
 * deliberately removed back in front of the customer. No crash, no error, just a quote that
 * overcharges. Moving the row to an archive keeps the hard delete, so no read anywhere needs a
 * filter and nothing can leak.
 *
 * WHY ONE STATEMENT
 *
 * The delete and the record must not be able to come apart, and a writable CTE is stronger than
 * wrapping two statements in a transaction: it is one round trip, and the INSERT is fed by the
 * DELETE's own RETURNING. A statement retried after an ambiguous failure therefore archives
 * nothing — the row is already gone, `removed` is empty, and the INSERT writes zero rows. The
 * archive's primary key is the original line's id, so even a double-run cannot double-count.
 *
 * WHY `FOR UPDATE`
 *
 * The Draft check cannot be a plain subquery. Under READ COMMITTED each statement reads through
 * a snapshot taken when it started, and Postgres only re-checks the predicate for rows the
 * statement itself targets — this one targets `quote_line_items`, while a concurrent completion
 * writes `quotes`. So a plain subquery happily deletes a line from a quote that was completed
 * mid-statement, after the estimate has already posted to the CRM. Reproduced locally; the line
 * vanished from a COMPLETED quote. Locking the quote row gets the re-check a plain read does
 * not: the lock waits for the completing transaction, re-evaluates `status = 'DRAFT'` against
 * the committed version, finds COMPLETED, and the delete correctly matches nothing.
 *
 * Measured against a plain delete over 20k line items: +0.054ms, and +0.067ms with eight
 * workers contending on one quote. The quote row is already locked by `touchQuote` after every
 * line write, so this is not a new lock, only an earlier one.
 */

export type RemovalOutcome = {
  /** Rows actually removed. 0 means the quote was no longer a Draft — the caller's 409. */
  removed: number;
};

/**
 * Remove line items from a DRAFT quote, archiving each one.
 *
 * `itemIds` is a list so the ambiguous-reference path can resolve and remove in one call; every
 * id is still scoped to the quote and the Draft condition, so a stray id removes nothing.
 */
export async function removeLineItems(params: {
  quoteId: string;
  companyId: number;
  itemIds: string[];
  /** users.id of whoever removed the line. Null for the agent acting on its own. */
  deletedBy?: bigint | null;
}): Promise<RemovalOutcome> {
  const { quoteId, companyId, itemIds, deletedBy = null } = params;
  if (itemIds.length === 0) return { removed: 0 };

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH locked AS (
      SELECT id FROM quotes
       WHERE id = ${quoteId} AND company_id = ${companyId} AND status = 'DRAFT'
       FOR UPDATE
    ),
    removed AS (
      DELETE FROM quote_line_items
       WHERE id IN (${Prisma.join(itemIds)})
         AND quote_id IN (SELECT id FROM locked)
      RETURNING *
    )
    INSERT INTO quote_line_items_deleted
      (id, quote_id, agent_suggested, is_labor, quantity, unit_price, deleted_at, deleted_by, snapshot)
    SELECT r.id, r.quote_id, r.agent_suggested, r.is_labor, r.quantity, r.unit_price,
           now(), ${deletedBy}, to_jsonb(r)
      FROM removed r
    RETURNING id
  `;

  if (rows.length !== itemIds.length) {
    // Not an error on its own: a completed quote removes nothing, and the caller turns that
    // into a 409. Logged because a PARTIAL removal would mean an id outside this quote.
    logger.info("[LineItemRemoval] removed fewer lines than asked", {
      quoteId,
      asked: itemIds.length,
      removed: rows.length,
    });
  }

  return { removed: rows.length };
}
