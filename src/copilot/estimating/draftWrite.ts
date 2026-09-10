import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import logger from "../../lib/logger";

/**
 * Line-item writes that re-assert "this quote is still a DRAFT" in the UPDATE's own WHERE
 * clause, instead of trusting a status check made earlier in the request.
 *
 * WHY THIS EXISTS
 *
 * Every pricing path in this codebase has the same shape: check the quote is a Draft, make a
 * slow call, write the result. The slow call is the problem. A Home Depot resolve measured
 * 13.1s cold and 14–32s when five run in parallel; the background resolver sleeps 30s and then
 * 60s between its retries; an agent turn waits on an LLM. The status check and the write can
 * therefore be a full minute apart, and `POST /:quoteId/complete` can land in that gap.
 *
 * When it does, the write applies to a quote that has already been posted to QuickBooks and
 * ZenTrades. The payload for those posts is captured at the moment of the status flip, and a
 * completed quote is frozen — nothing re-syncs it. So the price lands in our database and never
 * reaches the CRM: the two sides disagree, silently, forever. That is the race this module
 * closes.
 *
 * Asserting the status inside the WHERE clause collapses the check and the write into one
 * statement. Measured against a real Postgres with query logging, Prisma emits a single
 * `UPDATE ... WHERE id = $1 AND EXISTS (SELECT ... FROM quotes ...)`, wrapped in its own
 * BEGIN/COMMIT, and the join drives off both primary keys.
 *
 * That shrinks the window; it does not mathematically erase it. Under READ COMMITTED the
 * subquery is evaluated against the snapshot taken at statement start, and Postgres only
 * re-checks the predicate for rows a concurrent transaction modified — the completion writes
 * `quotes`, not this line item, so it does not trigger that re-check. A `complete()` committing
 * inside the statement's own execution could still slip through. The honest claim is a window
 * measured in single-digit milliseconds instead of 13 to 90 seconds: five orders of magnitude,
 * not infinity. Closing the remainder needs the pricing write and the status flip to contend
 * for the same row (`SELECT ... FOR UPDATE` on the quote, or a version column) — worth doing if
 * the residue ever proves reachable, and not worth the lock scope today.
 *
 * A refused write returns false rather than throwing: the caller has already done the expensive
 * work and the quote is simply no longer eligible, which is an outcome to report, not an error
 * to raise.
 *
 * The safe direction is to drop the price, not half-apply it. `complete()` already refuses a
 * quote carrying an unpriced or estimate-priced line (quote.controller.ts, the
 * `blockingFlagCount` gate), so a quote that reached COMPLETED had a price on every line
 * already — what a refused write discards is an improvement on a number that was good enough
 * to ship, never the difference between a price and a blank.
 */

/**
 * The guarded WHERE clause, built separately so the precedence the whole fix rests on can be
 * asserted without a database (scripts/check-draft-write.ts).
 *
 * `extraWhere` is spread FIRST on purpose: the guard's own `id` and `quote` keys must win, so a
 * caller cannot widen the clause by passing either — only narrow it with additional conditions.
 * Inverting this order would silently un-scope every write in the module.
 */
export function draftLineItemWhere(
  lineItemId: string,
  companyId: number,
  extraWhere: Prisma.QuoteLineItemWhereInput = {}
): Prisma.QuoteLineItemWhereInput {
  return { ...extraWhere, id: lineItemId, quote: { companyId, status: "DRAFT" } };
}

/**
 * Update one line item if, and only if, its quote is still a DRAFT owned by this company.
 *
 * Returns false when nothing was written. `extraWhere` narrows further — pass
 * `{ manuallyEdited: false }` on any automatic path, so a technician's own figure is never
 * overwritten by a lookup that started before they typed it.
 */
export async function updateDraftLineItem(
  lineItemId: string,
  companyId: number,
  data: Prisma.QuoteLineItemUpdateManyMutationInput,
  extraWhere: Prisma.QuoteLineItemWhereInput = {}
): Promise<boolean> {
  const { count } = await prisma.quoteLineItem.updateMany({
    where: draftLineItemWhere(lineItemId, companyId, extraWhere),
    data,
  });
  if (count === 0)
    // Either the quote was completed while the lookup ran, or the row stopped matching
    // `extraWhere` — most often the technician typed their own price and set manuallyEdited.
    // Both mean the same thing to the caller: this result is stale, drop it.
    logger.info("Line-item write skipped: the quote or the row is no longer eligible", {
      lineItemId,
      companyId,
    });
  return count > 0;
}

/**
 * The many-row form: apply one identical payload to a set of line items, still Draft-only.
 *
 * Prisma wraps every `updateMany` in its own BEGIN/COMMIT, so the guard costs three round
 * trips where a bare `update` cost one. Per line that is invisible next to a 13-to-32-second
 * supplier lookup, but the pricebook sweep writes every open Draft line a company has —
 * sequentially, from a synchronous admin request, through a pool `lib/prisma.ts` caps at one
 * connection. Tripling the round trips there is the difference between a slow endpoint and a
 * stalled one.
 *
 * A sweep assigns the same price to every line matching a term, so batching by payload
 * collapses those N statements into one per distinct payload. Returns the number of rows
 * actually written, which is what the admin endpoints report back.
 */
export async function updateDraftLineItems(
  lineItemIds: string[],
  companyId: number,
  data: Prisma.QuoteLineItemUpdateManyMutationInput,
  extraWhere: Prisma.QuoteLineItemWhereInput = {}
): Promise<number> {
  if (lineItemIds.length === 0) return 0;
  const { count } = await prisma.quoteLineItem.updateMany({
    where: { ...extraWhere, id: { in: lineItemIds }, quote: { companyId, status: "DRAFT" } },
    data,
  });
  if (count < lineItemIds.length)
    logger.info("Some line-item writes skipped: those quotes are no longer Drafts", {
      companyId,
      requested: lineItemIds.length,
      written: count,
    });
  return count;
}

/**
 * Update quote-level columns if, and only if, the quote is still a DRAFT owned by this company.
 *
 * The line-item guard's sibling, for the agent turn's own writes — markup, customer details,
 * the once-per-quote ask latches. Those run AFTER the operations loop, so the pre-loop
 * `quoteIsDraft` check does not cover them: a completion landing while the loop persists a
 * dozen operations would otherwise still stamp a markup onto a frozen, already-synced quote.
 *
 * Refusal is silent, matching the line-item path: the turn is being discarded, and a partly
 * applied turn is worse than a dropped one.
 */
export async function updateDraftQuote(
  quoteId: string,
  companyId: number,
  data: Prisma.QuoteUpdateManyMutationInput
): Promise<boolean> {
  const { count } = await prisma.quote.updateMany({
    where: { id: quoteId, companyId, status: "DRAFT" },
    data,
  });
  if (count === 0)
    logger.info("Quote write skipped: the quote is no longer a Draft", { quoteId, companyId });
  return count > 0;
}

/**
 * True while the quote is a DRAFT this company owns. For callers whose writes are creates and
 * deletes rather than updates, which have no WHERE clause to hang the condition on — the agent
 * turn being the one that matters, since it persists a whole batch of operations after an LLM
 * call long enough for a completion to land inside it.
 *
 * This is a check, not a lock, so it narrows the window rather than closing it: a completion
 * committing in the microseconds between this read and the writes that follow still slips
 * through. That is a far smaller target than the length of an LLM call, and closing it
 * properly needs the batch and the status flip to contend for the same row — worth doing if
 * this ever proves reachable in practice, and not worth the transaction scope today.
 */
export async function quoteIsDraft(quoteId: string, companyId: number): Promise<boolean> {
  const row = await prisma.quote.findFirst({
    where: { id: quoteId, companyId, status: "DRAFT" },
    select: { id: true },
  });
  return row != null;
}
