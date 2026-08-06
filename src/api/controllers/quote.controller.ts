import { Response } from "express";
import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { RequestWithUser } from "../middlewares/auth";
import {
  runEstimatingTurn,
  countRecentFollowUps,
} from "../../copilot/estimating/estimatingAgent";
import { matchPricebook } from "../../copilot/estimating/pricebookMatch";
import { toQuoteDto, toLineItemDto } from "../../copilot/estimating/quoteDto";
import { buildQuoteDocx } from "../../copilot/estimating/quoteDocx";
import { EstimateTurn } from "../../copilot/estimate/estimateService";

/**
 * Estimating Agent: chat-as-quote REST surface. One chat = one quote for life
 * (PRD US1); every route is auth'd and scoped to the requesting technician.
 */

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ success: false, error: { status, message } });

function requireUser(req: RequestWithUser, res: Response) {
  try {
    return {
      userId: BigInt(req.user!.userId),
      companyId: req.user!.companyId,
    };
  } catch {
    fail(res, 400, "Numeric user id required (set X-User-Id when using dev bypass)");
    return null;
  }
}

/** Load the quote with items, enforcing ownership. */
async function loadOwnedQuote(quoteId: string, userId: bigint) {
  return prisma.quote.findFirst({
    where: { id: quoteId, userId },
    include: { lineItems: true },
  });
}

async function matcherFor(companyId: number) {
  const pricebook = await prisma.pricebookItem.findMany({ where: { companyId } });
  const matchable = pricebook.map((p) => ({
    id: p.id,
    code: p.code,
    description: p.description,
    unit: p.unit,
    unitPrice: Number(p.unitPrice),
    synonyms: p.synonyms,
  }));
  return (description: string) => matchPricebook(description, matchable);
}

export class QuoteController {
  /** POST /api/v1/quotes — new chat = new empty quote in Draft. */
  static async create(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const conversation = await prisma.conversation.create({
      data: {
        userId: user.userId,
        channelType: "MESSAGING",
        members: [String(user.userId)],
        metadata: { kind: "estimating" },
      },
    });
    const quote = await prisma.quote.create({
      data: {
        conversationId: conversation.id,
        userId: user.userId,
        companyId: user.companyId,
      },
      include: { lineItems: true },
    });
    res.status(201).json({ success: true, data: toQuoteDto(quote) });
  }

  /** GET /api/v1/quotes?status=DRAFT|COMPLETED — the technician's own chats only. */
  static async list(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const status = req.query.status === "COMPLETED" ? "COMPLETED" : "DRAFT";
    const quotes = await prisma.quote.findMany({
      where: { userId: user.userId, status },
      include: { lineItems: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: quotes.map(toQuoteDto) });
  }

  /** GET /api/v1/quotes/:quoteId — quote + items + full message history (resume). */
  static async get(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    const messages = await prisma.message.findMany({
      where: { conversationId: quote.conversationId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        senderType: true,
        content: true,
        metadata: true,
        createdAt: true,
      },
    });
    res.json({ success: true, data: { ...toQuoteDto(quote), messages } });
  }

  /** POST /api/v1/quotes/:quoteId/messages — one agent turn. */
  static async sendMessage(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!content) return fail(res, 400, "content is required"); // nothing said → no line item, no guess
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    if (quote.status === "COMPLETED")
      return fail(res, 409, "Quote is Completed and frozen — move it back to Draft to edit");

    const priorMessages = await prisma.message.findMany({
      where: { conversationId: quote.conversationId },
      orderBy: { createdAt: "asc" },
      select: { senderType: true, content: true, metadata: true },
    });

    await prisma.message.create({
      data: {
        conversationId: quote.conversationId,
        senderType: "USER",
        senderId: user.userId,
        content,
      },
    });

    const history: EstimateTurn[] = priorMessages
      .filter((m) => m.senderType === "USER" || m.senderType === "AI")
      .slice(-20)
      .map((m) => ({
        role: m.senderType === "USER" ? ("user" as const) : ("assistant" as const),
        content: m.content,
      }));

    let turn;
    try {
      turn = await runEstimatingTurn({
        quoteId: quote.id,
        companyId: user.companyId,
        utterance: content,
        history,
        followUpsAsked: countRecentFollowUps(priorMessages),
      });
    } catch (err) {
      logger.error("Estimating turn failed", {
        quoteId: quote.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return fail(res, 502, "The agent could not process that — please try again");
    }

    const aiMessage = await prisma.message.create({
      data: {
        conversationId: quote.conversationId,
        senderType: "AI",
        content: turn.reply,
        metadata: { isFollowUpQuestion: turn.isFollowUpQuestion },
      },
    });

    const updated = await loadOwnedQuote(quote.id, user.userId);
    res.json({
      success: true,
      data: {
        reply: {
          id: aiMessage.id,
          senderType: "AI",
          content: turn.reply,
          metadata: aiMessage.metadata,
          createdAt: aiMessage.createdAt,
        },
        quote: toQuoteDto(updated!),
      },
    });
  }

  /** POST /api/v1/quotes/:quoteId/items — manual add (US6). */
  static async addItem(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    if (quote.status === "COMPLETED") return fail(res, 409, "Quote is Completed and frozen");
    const { description, quantity, unit, unitPrice, totalPrice } = req.body ?? {};
    if (!description || typeof description !== "string")
      return fail(res, 400, "description is required");

    const manualPrice = unitPrice != null || totalPrice != null;
    // No manual price → same pricebook matching as a spoken item (US6).
    const match = manualPrice ? null : (await matcherFor(user.companyId))(description);
    const nextSort =
      quote.lineItems.length > 0
        ? Math.max(...quote.lineItems.map((i) => i.sortOrder)) + 1
        : 0;
    const item = await prisma.quoteLineItem.create({
      data: {
        quoteId: quote.id,
        description,
        quantity: quantity ?? null,
        unit: unit ?? match?.unit ?? null,
        unitPrice: unitPrice ?? match?.unitPrice ?? null,
        totalPrice: totalPrice ?? null,
        pricebookCode: match?.code ?? null,
        manuallyEdited: manualPrice,
        sortOrder: nextSort,
      },
    });
    res.status(201).json({ success: true, data: toLineItemDto(item) });
  }

  /**
   * PATCH /api/v1/quotes/:quoteId/items/:itemId — direct edits + flag resolution:
   * body may carry description/quantity/unit/unitPrice/totalPrice,
   * confirm: true (accept an agent-suggested item), or
   * resolveCandidateId (apply a pending ambiguous action to the chosen item).
   */
  static async updateItem(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    if (quote.status === "COMPLETED") return fail(res, 409, "Quote is Completed and frozen");
    const item = quote.lineItems.find((i) => i.id === req.params.itemId);
    if (!item) return fail(res, 404, "Line item not found");
    const body = req.body ?? {};

    // Resolve an ambiguous reference by explicit selection (US3 AC6 / US6).
    if (body.resolveCandidateId) {
      const action = item.ambiguousAction as {
        action: "remove" | "update";
        candidateItemIds: string[];
        fields?: { description?: string; quantity?: number; unit?: string };
      } | null;
      if (!action) return fail(res, 400, "Item has no pending ambiguous action");
      if (!action.candidateItemIds.includes(body.resolveCandidateId))
        return fail(res, 400, "Not one of the ambiguous candidates");
      if (action.action === "remove") {
        await prisma.quoteLineItem.delete({ where: { id: body.resolveCandidateId } });
      } else {
        await prisma.quoteLineItem.update({
          where: { id: body.resolveCandidateId },
          data: { ...action.fields },
        });
      }
      await prisma.quoteLineItem.delete({ where: { id: item.id } }); // drop placeholder
      const updated = await loadOwnedQuote(quote.id, user.userId);
      return res.json({ success: true, data: toQuoteDto(updated!) });
    }

    const data: Record<string, unknown> = {};
    if (body.confirm === true) data.agentSuggested = false;
    if (typeof body.description === "string" && body.description !== item.description) {
      data.description = body.description;
      // Edited description on an unmatched, un-priced item → try matching again.
      if (!item.manuallyEdited && item.unitPrice == null && body.unitPrice == null) {
        const match = (await matcherFor(user.companyId))(body.description);
        data.pricebookCode = match?.code ?? null;
        data.unitPrice = match?.unitPrice ?? null;
        if (match?.unit && body.unit == null && item.unit == null) data.unit = match.unit;
      }
    }
    if (body.quantity !== undefined) data.quantity = body.quantity;
    if (body.unit !== undefined) data.unit = body.unit;
    // Manual price entry is used as-is, skips pricebook, and is flagged (US6).
    if (body.unitPrice !== undefined) {
      data.unitPrice = body.unitPrice;
      data.manuallyEdited = true;
    }
    if (body.totalPrice !== undefined) {
      data.totalPrice = body.totalPrice; // not required to equal qty × unit price
      data.manuallyEdited = true;
    }
    if (Object.keys(data).length === 0) return fail(res, 400, "Nothing to update");
    await prisma.quoteLineItem.update({ where: { id: item.id }, data });
    const updated = await loadOwnedQuote(quote.id, user.userId);
    res.json({ success: true, data: toQuoteDto(updated!) });
  }

  /** DELETE /api/v1/quotes/:quoteId/items/:itemId */
  static async removeItem(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    if (quote.status === "COMPLETED") return fail(res, 409, "Quote is Completed and frozen");
    const item = quote.lineItems.find((i) => i.id === req.params.itemId);
    if (!item) return fail(res, 404, "Line item not found");
    await prisma.quoteLineItem.delete({ where: { id: item.id } });
    const updated = await loadOwnedQuote(quote.id, user.userId);
    res.json({ success: true, data: toQuoteDto(updated!) });
  }

  /** POST /api/v1/quotes/:quoteId/complete — gated on unresolved blocking flags (US6/US9). */
  static async complete(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    const dto = toQuoteDto(quote);
    if (dto.blockingFlagCount > 0)
      return fail(
        res,
        409,
        `${dto.blockingFlagCount} line item(s) still need attention before this quote can be marked Completed`
      );
    const updated = await prisma.quote.update({
      where: { id: quote.id },
      data: { status: "COMPLETED", completedAt: new Date() },
      include: { lineItems: true },
    });
    res.json({ success: true, data: toQuoteDto(updated) });
  }

  /** POST /api/v1/quotes/:quoteId/reopen — back to Draft; never touches line items (US9). */
  static async reopen(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    const updated = await prisma.quote.update({
      where: { id: quote.id },
      data: { status: "DRAFT", completedAt: null },
      include: { lineItems: true },
    });
    res.json({ success: true, data: toQuoteDto(updated) });
  }

  /** GET /api/v1/quotes/:quoteId/docx — basic Word export, marked per current state (US7). */
  static async downloadDocx(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    const dto = toQuoteDto(quote);
    const buffer = await buildQuoteDocx(dto);
    const stamp = new Date(dto.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, "-");
    res
      .setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
      .setHeader(
        "Content-Disposition",
        `attachment; filename="quote-${stamp}-${dto.status.toLowerCase()}.docx"`
      )
      .send(buffer);
  }
}
