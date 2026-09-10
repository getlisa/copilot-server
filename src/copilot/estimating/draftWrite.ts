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
 * Asserting the status inside the WHERE clause makes the check and the write a single atomic
 * statement, so there is no gap left to lose. A refused write returns false rather than
 * throwing: the caller has already done the expensive work and the quote is simply no longer
 * eligible, which is an outcome to report, not an error to raise.
 *
 * The safe direction is to drop the price, not half-apply it. `complete()` already refuses a
 * quote carrying an unpriced or estimate-priced line (quote.controller.ts, the
 * `blockingFlagCount` gate), so a quote that reached COMPLETED had a price on every line
 * already — what a refused write discards is an improvement on a number that was good enough
 * to ship, never the difference between a price and a blank.
 */

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
    where: { ...extraWhere, id: lineItemId, quote: { companyId, status: "DRAFT" } },
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
