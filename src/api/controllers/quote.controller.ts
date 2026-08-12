import { Response } from "express";
import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { RequestWithUser } from "../middlewares/auth";
import {
  runEstimatingTurn,
  countRecentFollowUps,
} from "../../copilot/estimating/estimatingAgent";
import { matchPricebook } from "../../copilot/estimating/pricebookMatch";
import { resolveFromHomeDepot } from "../../copilot/estimating/homeDepotCatalog";
import { packAwareQuantity } from "../../copilot/estimating/packMath";
import { toQuoteDto, toLineItemDto, type CatalogIndex } from "../../copilot/estimating/quoteDto";
import { buildQuoteDocx } from "../../copilot/estimating/quoteDocx";
import { buildProposalDocx } from "../../copilot/estimating/proposalDocx";
import { generateProposalNarrative } from "../../copilot/estimating/proposalNarrative";
import { draftProposalEmail, renderProposalHtml } from "../../copilot/estimating/proposalEmail";
import { loadQuoteHeader } from "../../copilot/estimate/pdf/quoteHeader";
import { sendEmail, isEmailConfigured, SENDGRID_FROM_EMAIL, SENDGRID_FROM_NAME } from "../../lib/email";
import { getPresignedUrlForKey } from "../../lib/s3";
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

/**
 * One answer to a clarifying question, submitted from the question card's chips.
 *
 * Persisted on the answering USER message so the card itself can show what was picked.
 * Without this the only record of the answer is the message text, which the UI then has to
 * echo back as a second bubble — the same questions and answers rendered twice.
 */
interface SubmittedAnswer {
  questionId: string;
  question: string;
  value: string;
  /** Typed into the "Other" box rather than picked from the options. */
  fromOther?: boolean;
}

const MAX_ANSWERS = 8;
const MAX_ANSWER_CHARS = 400;

/**
 * Client-supplied answers, or null when this turn isn't a question-card submission.
 *
 * Accepts either a bare list of chosen values (in question order) or objects naming the
 * question each answer belongs to. Both clients are in use, so both are read here and
 * normalised once rather than branched on downstream.
 */
function parseAnswers(input: unknown): SubmittedAnswer[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_ANSWER_CHARS) : null;
  const answers: SubmittedAnswer[] = [];
  for (const raw of input.slice(0, MAX_ANSWERS)) {
    if (typeof raw === "string") {
      const value = str(raw);
      if (value) answers.push({ questionId: "", question: "", value });
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const value = str(a.value);
    if (!value) continue;
    answers.push({
      questionId: str(a.questionId) ?? "",
      question: str(a.question) ?? "",
      value,
      fromOther: a.fromOther === true,
    });
  }
  return answers.length > 0 ? answers : null;
}

/** The clarifying questions an AI turn asked, read back out of its stored blocks. */
function questionsOf(
  message: { senderType: string; metadata: unknown } | undefined
): { id?: string; question?: string }[] {
  if (!message || message.senderType !== "AI") return [];
  const blocks = (message.metadata as any)?.blocks;
  if (!Array.isArray(blocks)) return [];
  const questions = blocks.find((b: any) => b?.kind === "questions")?.data?.questions;
  return Array.isArray(questions) ? questions : [];
}

/**
 * Tie each answer to the question it answers. When the client sent only the chosen values,
 * position against the card's questions is the only link there is — which is exactly the
 * order the card renders them in.
 */
function alignAnswers(
  answers: SubmittedAnswer[],
  questions: { id?: string; question?: string }[]
): SubmittedAnswer[] {
  return answers.map((a, i) => ({
    ...a,
    questionId: a.questionId || questions[i]?.id || `q${i + 1}`,
    question: a.question || questions[i]?.question || "",
  }));
}

/** Load the quote with items, enforcing ownership. */
async function loadOwnedQuote(quoteId: string, userId: bigint) {
  return prisma.quote.findFirst({
    where: { id: quoteId, userId },
    include: { lineItems: true },
  });
}

/**
 * Catalog rows for the codes a quote actually uses, so each line can carry its product link,
 * brand and rating. Only HOME_DEPOT rows matter to the DTO, but fetching by code keeps this a
 * single indexed query regardless of source.
 */
async function catalogFor(
  quote: { companyId: number; lineItems: { pricebookCode: string | null }[] }
): Promise<CatalogIndex> {
  const codes = [...new Set(quote.lineItems.map((i) => i.pricebookCode).filter((c): c is string => !!c))];
  if (codes.length === 0) return new Map();
  const rows = await prisma.pricebookItem.findMany({
    where: { companyId: quote.companyId, code: { in: codes } },
  });
  return new Map(rows.map((r) => [r.code, r]));
}

/** toQuoteDto with product provenance attached. */
async function quoteDtoWithProducts(quote: Parameters<typeof toQuoteDto>[0] & { companyId: number }) {
  return toQuoteDto(quote, await catalogFor(quote));
}

/** Shared proposal assembly: header from DB branding, DOCX buffer, and the DTO. */
async function buildProposalParts(quote: NonNullable<Awaited<ReturnType<typeof loadOwnedQuote>>>) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: quote.conversationId },
  });
  const header = await loadQuoteHeader({
    jobId: conversation?.jobId,
    userId: quote.userId,
    companyId: quote.companyId,
  });
  const dto = await quoteDtoWithProducts(quote);
  const projectTitle =
    header.customerName !== "Customer" ? `Work for ${header.customerName}` : "Scope of Work";
  // Scope-of-work prose + job-specific assumptions from the chat context.
  // Falls back to the raw materials list when generation fails.
  const narrative = await generateProposalNarrative({
    conversationId: quote.conversationId,
    lineItems: dto.lineItems,
  });
  const buffer = await buildProposalDocx({
    header,
    projectTitle,
    projectAddress: header.serviceAddress,
    date: new Date(),
    scopeSections: narrative?.scopeSections ?? [
      {
        title: "Scope of Work",
        bullets: dto.lineItems.map((item) =>
          item.quantity != null
            ? `${item.description} — ${item.quantity}${item.unit ? ` ${item.unit}` : ""}`
            : item.description
        ),
      },
    ],
    assumptions: narrative?.assumptions,
    total: dto.total,
  });
  return { header, dto, projectTitle, buffer };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function matcherFor(companyId: number) {
  const pricebook = await prisma.pricebookItem.findMany({ where: { companyId } });
  const matchable = pricebook.map((p) => ({
    id: p.id,
    code: p.code,
    description: p.description,
    unit: p.unit,
    unitPrice: Number(p.unitPrice),
    synonyms: p.synonyms,
    // Needed so a hand-added count is rounded to whole packs like a spoken one — see packMath.
    packageQuantity: p.packageQuantity == null ? null : Number(p.packageQuantity),
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
    res.status(201).json({ success: true, data: await quoteDtoWithProducts(quote) });
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
    res.json({ success: true, data: await Promise.all(quotes.map((q) => quoteDtoWithProducts(q))) });
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
        contentType: true,
        attachments: true,
        metadata: true,
        createdAt: true,
      },
    });
    // Stored presigned URLs expire — re-sign image attachments from their s3Key.
    const hydrated = await Promise.all(
      messages.map(async (m) => {
        const atts = Array.isArray(m.attachments) ? (m.attachments as any[]) : [];
        if (atts.length === 0) return m;
        const attachments = await Promise.all(
          atts.map(async (a) => {
            const s3Key = a?.metadata?.s3Key;
            if (!s3Key) return a;
            try {
              return { ...a, url: await getPresignedUrlForKey(s3Key) };
            } catch {
              return a;
            }
          })
        );
        return { ...m, attachments };
      })
    );
    res.json({ success: true, data: { ...(await quoteDtoWithProducts(quote)), messages: hydrated } });
  }

  /** POST /api/v1/quotes/:quoteId/messages — one agent turn. */
  static async sendMessage(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!content) return fail(res, 400, "content is required"); // nothing said → no line item, no guess
    const imageUrls: string[] = Array.isArray(req.body?.imageUrls)
      ? req.body.imageUrls.filter((u: unknown) => typeof u === "string").slice(0, 4)
      : [];
    const submitted = parseAnswers(req.body?.answers);
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    if (quote.status === "COMPLETED")
      return fail(res, 409, "Quote is Completed and frozen — move it back to Draft to edit");

    const priorMessages = await prisma.message.findMany({
      where: { conversationId: quote.conversationId },
      orderBy: { createdAt: "asc" },
      select: { id: true, senderType: true, content: true, metadata: true },
    });

    // Which question card these answers belong to. The client's id is honoured only when it
    // names an AI turn of THIS conversation; otherwise fall back to the most recent turn that
    // actually asked something, so a client that sends only the chosen values still lands.
    const card = submitted
      ? priorMessages.find(
          (m) => m.id === req.body?.answeredMessageId && m.senderType === "AI"
        ) ?? [...priorMessages].reverse().find((m) => questionsOf(m).length > 0)
      : undefined;
    const answers = submitted ? alignAnswers(submitted, questionsOf(card)) : null;
    const answeredMessageId = card?.id ?? null;

    // With images, the upload endpoint already persisted this turn's USER message
    // (IMAGE message with attachments) — creating another would duplicate it, and
    // that trailing row must not also appear in history as a prior turn.
    if (imageUrls.length > 0) {
      const last = priorMessages[priorMessages.length - 1];
      if (last?.senderType === "USER" && last.content === content) priorMessages.pop();
    } else {
      await prisma.message.create({
        data: {
          conversationId: quote.conversationId,
          senderType: "USER",
          senderId: user.userId,
          content,
          // `content` still carries the full question → answer text: the model needs it in
          // history. The metadata is what lets the UI show the answers as answers.
          //
          // Two shapes, deliberately: `answers` stays the flat list of chosen values that the
          // compact-chip bubble renders, and `questionAnswers` adds which question each one
          // belongs to, which is what lets the original card show its own selection. Widening
          // `answers` in place would have broken the first renderer.
          ...(answers
            ? {
                metadata: {
                  answers: answers.map((a) => a.value),
                  questionAnswers: answers,
                  answeredMessageId,
                } as any,
              }
            : {}),
        },
      });
    }

    const history: EstimateTurn[] = priorMessages
      .filter((m) => m.senderType === "USER" || m.senderType === "AI")
      .slice(-20)
      .map((m) => {
        // The reply no longer restates clarifying questions (they render as a
        // separate MCQ block), so re-append them here or the model forgets what
        // it asked when the technician answers in free text.
        let content = m.content;
        const qs = (m.metadata as any)?.blocks?.find(
          (b: any) => b?.kind === "questions"
        )?.data?.questions;
        if (m.senderType === "AI" && Array.isArray(qs) && qs.length > 0) {
          content +=
            "\n\n[Questions shown as multiple-choice]:\n" +
            qs.map((q: any) => `- ${q.question}`).join("\n");
        }
        return {
          role: m.senderType === "USER" ? ("user" as const) : ("assistant" as const),
          content,
        };
      });

    let turn;
    try {
      turn = await runEstimatingTurn({
        quoteId: quote.id,
        companyId: user.companyId,
        utterance: content,
        history,
        followUpsAsked: countRecentFollowUps(priorMessages),
        imageUrls,
      });
    } catch (err) {
      logger.error("Estimating turn failed", {
        quoteId: quote.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return fail(res, 502, "The agent could not process that — please try again");
    }

    // Clarifying questions ship as the buddy chat's block format so the UI
    // renders them as multiple-choice chips with an "Other" free-text box.
    const metadata: Record<string, unknown> = { isFollowUpQuestion: turn.isFollowUpQuestion };
    if (turn.questions.length > 0) {
      metadata.blocks = [
        { kind: "markdown", text: turn.reply },
        {
          kind: "questions",
          data: {
            questions: turn.questions.map((q, qi) => ({
              id: `q${qi + 1}`,
              question: q.question,
              options: q.options.map((opt, oi) => ({
                id: `q${qi + 1}o${oi + 1}`,
                label: opt,
                value: opt,
              })),
              allowOther: true,
            })),
          },
        },
      ];
    }
    const aiMessage = await prisma.message.create({
      data: {
        conversationId: quote.conversationId,
        senderType: "AI",
        content: turn.reply,
        metadata: metadata as any,
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
        quote: await quoteDtoWithProducts(updated!),
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
    // A hand-added part is bought the same way a spoken one is: if the matched row is a pack,
    // round the count up to a whole pack. A caller-supplied price means they priced it
    // themselves, so leave their numbers alone.
    const addUnit = unit ?? match?.unit ?? null;
    const addQty = manualPrice
      ? { quantity: quantity ?? null }
      : packAwareQuantity(quantity ?? null, addUnit, match?.packageQuantity, match?.unit);
    const item = await prisma.quoteLineItem.create({
      data: {
        quoteId: quote.id,
        description,
        quantity: addQty.quantity,
        unit: addUnit,
        unitPrice: unitPrice ?? match?.unitPrice ?? null,
        totalPrice: totalPrice ?? null,
        pricebookCode: match?.code ?? null,
        manuallyEdited: manualPrice,
        sortOrder: nextSort,
      },
    });
    res.status(201).json({
      success: true,
      data: toLineItemDto(item, await catalogFor({ companyId: user.companyId, lineItems: [item] })),
    });
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
      return res.json({ success: true, data: await quoteDtoWithProducts(updated!) });
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
    res.json({ success: true, data: await quoteDtoWithProducts(updated!) });
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
    res.json({ success: true, data: await quoteDtoWithProducts(updated!) });
  }

  /**
   * POST /api/v1/quotes/:quoteId/items/:itemId/price — on-demand price search for one line.
   * Company pricebook first (instant, free), then the awaited Home Depot resolver — a cold
   * search runs 15–30s, so the client shows a spinner for this request. An explicit search
   * replaces a manually typed price: the technician asked for the catalog number.
   */
  static async priceItem(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    if (quote.status === "COMPLETED") return fail(res, 409, "Quote is Completed and frozen");
    const item = quote.lineItems.find((i) => i.id === req.params.itemId);
    if (!item) return fail(res, 404, "Line item not found");

    const body = req.body ?? {};
    const term =
      typeof body.searchTerm === "string" && body.searchTerm.trim()
        ? body.searchTerm.trim()
        : item.description;

    const match = (await matcherFor(user.companyId))(term);
    const resolved = match ?? (await resolveFromHomeDepot(term, user.companyId));
    if (!resolved)
      return fail(
        res,
        404,
        `No catalog match for "${term}" — reword the description to a product name (size + part), or type a price.`
      );

    const unit = resolved.unit ?? item.unit;
    const packed = packAwareQuantity(
      item.quantity == null ? null : Number(item.quantity),
      unit,
      resolved.packageQuantity ?? null,
      resolved.unit
    );
    await prisma.quoteLineItem.update({
      where: { id: item.id },
      data: {
        unitPrice: resolved.unitPrice,
        pricebookCode: resolved.code,
        manuallyEdited: false,
        ...(resolved.unit ? { unit: resolved.unit } : {}),
        ...(packed.rounded ? { quantity: packed.quantity } : {}),
      },
    });
    const updated = await loadOwnedQuote(quote.id, user.userId);
    res.json({ success: true, data: await quoteDtoWithProducts(updated!) });
  }

  /** POST /api/v1/quotes/:quoteId/complete — gated on unresolved blocking flags (US6/US9). */
  static async complete(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    const dto = await quoteDtoWithProducts(quote);
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
    res.json({ success: true, data: await quoteDtoWithProducts(updated) });
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
    res.json({ success: true, data: await quoteDtoWithProducts(updated) });
  }

  /** GET /api/v1/quotes/:quoteId/docx — basic Word export, marked per current state (US7). */
  static async downloadDocx(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    const dto = await quoteDtoWithProducts(quote);
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

  /** GET /api/v1/quotes/:quoteId/proposal-docx — branded bid-proposal Word export. */
  static async downloadProposalDocx(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    const { buffer } = await buildProposalParts(quote);
    const stamp = new Date().toISOString().slice(0, 10);
    res
      .setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
      .setHeader("Content-Disposition", `attachment; filename="proposal-${stamp}.docx"`)
      .send(buffer);
  }

  /** GET /api/v1/quotes/:quoteId/email-draft — drafted proposal email for in-app review. */
  static async emailDraft(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    const { header, dto, projectTitle } = await buildProposalParts(quote);
    const draft = draftProposalEmail({
      header,
      projectTitle,
      lineItems: dto.lineItems,
      total: dto.total,
    });
    res.json({
      success: true,
      data: { to: String(req.user?.email ?? ""), ...draft },
    });
  }

  /**
   * POST /api/v1/quotes/:quoteId/email — send the reviewed proposal email, DOCX attached.
   * Body: { to, subject, body } as reviewed/edited in the app.
   */
  static async emailProposal(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    if (!isEmailConfigured())
      return fail(res, 503, "Email is not configured on the server");
    const to = String(req.body?.to ?? "").trim();
    if (!EMAIL_RE.test(to)) return fail(res, 400, "A valid recipient email is required");
    const subject = String(req.body?.subject ?? "").trim();
    const body = String(req.body?.body ?? "").trim();
    if (!subject || !body) return fail(res, 400, "Subject and body are required");
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");

    const { header, buffer } = await buildProposalParts(quote);
    await sendEmail({
      to,
      from: SENDGRID_FROM_EMAIL,
      fromName: SENDGRID_FROM_NAME || header.companyName,
      ...(header.companyEmail ? { replyTo: header.companyEmail } : {}),
      subject,
      html: renderProposalHtml(header, body),
      text: body,
      attachment: {
        filename: `proposal-${new Date().toISOString().slice(0, 10)}.docx`,
        content: buffer,
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    });
    logger.info("Proposal emailed", { quoteId: quote.id, to });
    res.json({ success: true, data: { sent: true, to } });
  }
}
