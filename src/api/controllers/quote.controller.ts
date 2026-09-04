import { Response } from "express";
import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { RequestWithUser } from "../middlewares/auth";
import { runEstimatingTurn } from "../../copilot/estimating/estimatingAgent";
import { dedupeSharedRows } from "../../copilot/estimating/pricebookMatch";
import { resolveFromHomeDepot } from "../../copilot/estimating/homeDepotCatalog";
import { loadCompanyPricing } from "../../copilot/estimating/companyPricing";
import { packAwareQuantity, unitsCompatible } from "../../copilot/estimating/packMath";
import {
  toQuoteDto,
  toLineItemDto,
  stripMarkup,
  ESTIMATED_PRICE_CODE,
  type CatalogIndex,
  type PricebookNameIndex,
} from "../../copilot/estimating/quoteDto";
import { renderQuoteDocument } from "../../copilot/estimating/templates";
import { type ProposalInput } from "../../copilot/estimating/proposalDocx";
import {
  renderProposalDocx,
  renderProposalPdf,
} from "../../copilot/estimating/proposalEstimate";
import { generateProposalNarrative } from "../../copilot/estimating/proposalNarrative";
import { scrubAddressFromTitle } from "../../copilot/estimating/scrubAddress";
import { draftProposalEmail, renderProposalHtml } from "../../copilot/estimating/proposalEmail";
import { loadQuoteHeader } from "../../copilot/estimate/pdf/quoteHeader";
import { sendEmail, isEmailConfigured, SENDGRID_FROM_EMAIL, SENDGRID_FROM_NAME } from "../../lib/email";
import { qboConnectionFor, qboConnected, syncQuoteToQbo } from "../../lib/qbo";
import { getPresignedUrlForKey, uploadBufferToS3 } from "../../lib/s3";
import { randomUUID } from "crypto";
import sharp from "sharp";
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
  // Same visibility rule as matching: a code priced from another company's accepted
  // HOME_DEPOT cache row must still resolve its link/brand here, or the line loses them.
  const rows = await prisma.pricebookItem.findMany({
    where: {
      code: { in: codes },
      OR: [{ companyId: quote.companyId }, { source: "HOME_DEPOT", provisional: false }],
    },
  });
  return new Map(dedupeSharedRows(rows, quote.companyId).map((r) => [r.code, r]));
}

/** Pricebook names for the review screen's price-source display (US8). */
async function bookNamesFor(companyId: number): Promise<PricebookNameIndex> {
  const books = await prisma.pricebook.findMany({
    where: { companyId },
    select: { id: true, name: true },
  });
  return new Map(books.map((b) => [b.id, b.name]));
}

/** toQuoteDto with product provenance and pricebook names attached. */
async function quoteDtoWithProducts(quote: Parameters<typeof toQuoteDto>[0] & { companyId: number }) {
  const [catalog, bookNames] = await Promise.all([
    catalogFor(quote),
    bookNamesFor(quote.companyId),
  ]);
  return toQuoteDto(quote, catalog, bookNames);
}

/**
 * Shared proposal assembly: header from DB branding, the DTO, and the ProposalInput
 * that both document builders (docx download, PDF email attachment) render from.
 */
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
  // Scope-of-work prose + job-specific assumptions/exclusions/coordination from the chat
  // context. Falls back to the raw materials list when generation fails.
  const narrative = await generateProposalNarrative({
    conversationId: quote.conversationId,
    lineItems: dto.lineItems,
  });
  // Precedence: the quote's own stored customer fields (typed on the Invoice tab or captured
  // in chat) are what the technician explicitly said — they beat both the CRM header and the
  // narrative's LLM-recovered guesses. Below that, the CRM header wins when it has real data,
  // and the narrative's conversation-recovered fields fill the placeholders ("Customer",
  // empty address) that shipped on real proposals.
  const customerName =
    quote.customerName ??
    (header.customerName !== "Customer"
      ? header.customerName
      : narrative?.project.customerName ?? header.customerName);
  // The title names the WORK only — an address in it would print on the documents and land in
  // the email subject/greeting. The prompt forbids it and this scrub enforces it; a title the
  // scrub empties falls through to the same defaults as no title at all.
  const scrubbedTitle = narrative?.project.title
    ? scrubAddressFromTitle(narrative.project.title, [
        quote.customerAddress,
        header.serviceAddress,
        header.billingAddress,
        narrative.project.siteAddress,
      ])
    : null;
  const projectTitle =
    scrubbedTitle || (customerName !== "Customer" ? `Work for ${customerName}` : "Scope of Work");
  const unpricedCount = dto.lineItems.filter((i) => i.flags.includes("unmatched")).length;
  // Photos attached in the estimator chat render at the bottom of the proposal.
  const photos = await prisma.imageFile.findMany({
    where: { conversationId: quote.conversationId },
    orderBy: { createdAt: "asc" },
    select: { s3Key: true, mimeType: true },
  });
  // Every consumer (docx, PDF, email draft/send) must see the recovered customer name —
  // handing out the raw header made the email greet "there" while the document said the name.
  // Stored quote fields override the CRM's here too, so the proposal's customer line prints
  // what the technician entered.
  const mergedHeader = {
    ...header,
    customerName,
    ...(quote.customerAddress ? { billingAddress: quote.customerAddress } : {}),
    ...(quote.customerPhone ? { customerPhone: quote.customerPhone } : {}),
  };
  // The company's own proposal format (null → the default estimate document) and their terms.
  const company = await prisma.companies.findUnique({
    where: { id: quote.companyId },
    select: { proposal_template: true, footer_terms: true },
  });
  const input: ProposalInput = {
    header: mergedHeader,
    projectTitle,
    date: new Date(),
    // The document's line table. DTO prices already carry the markup, so the document shows
    // exactly what the review screen shows.
    lineItems: dto.lineItems.map((i) => ({
      code: i.pricebookCode,
      description: i.description,
      quantity: i.quantity,
      unit: i.unit,
      unitPrice: i.unitPrice,
      totalPrice: i.totalPrice,
      optionGroup: i.optionGroup,
      isLabor: i.isLabor,
      priceSource: i.priceSource,
      unmatched: i.flags.includes("unmatched"),
    })),
    terms: company?.footer_terms
      ? company.footer_terms.split(/\r?\n+/).map((l) => l.trim()).filter(Boolean)
      : undefined,
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
    exclusions: narrative?.exclusions,
    coordination: narrative?.coordination,
    total: dto.total,
    optionTotals: dto.optionTotals,
    unpricedCount,
    photos,
  };
  const proposalTemplate = company?.proposal_template ?? null;
  return { header: mergedHeader, dto, projectTitle, input, unpricedCount, proposalTemplate };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The quote's directly-attached images (PRD US6): rows with a null messageId, i.e. attached
 * via the quote's attach action rather than sent with a chat message. Chat-message images are
 * deliberately NOT in this list — they belong to the conversation history, and only
 * message-attached images ever reach the agent as vision input.
 */
async function quoteImagesDto(conversationId: string) {
  const images = await prisma.imageFile.findMany({
    where: { conversationId, messageId: null },
    orderBy: { createdAt: "asc" },
  });
  return Promise.all(
    images.map(async (img) => ({
      id: img.id,
      url: await getPresignedUrlForKey(img.s3Key),
      mimeType: img.mimeType,
      filename: img.filename,
      createdAt: img.createdAt.toISOString(),
    }))
  );
}

/**
 * Company matcher with the PRD's ordering built in: the client's own books first (higher
 * price wins a collision), the Home Depot cache only when their fallback toggle is on.
 * Matches carry sourcePricebookId so callers can persist provenance (US8).
 */
async function matcherFor(companyId: number) {
  const pricing = await loadCompanyPricing(companyId);
  const match = (description: string) => pricing.match(description);
  match.fallbackEnabled = pricing.fallbackEnabled;
  return match;
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
    // Stamp the company's active template at creation (template-config PRD): a later
    // template reassignment only affects quotes created after it, never this one.
    const [activeTemplate, config] = await Promise.all([
      prisma.quoteTemplate.findFirst({
        where: { companyId: user.companyId, isActive: true },
        select: { id: true },
      }),
      // Company default markup (QBO PRD US7): the STARTING value only — stamped here like the
      // template, so changing the default never touches an existing quote.
      prisma.company_configs.findUnique({
        where: { company_id: user.companyId },
        select: { default_markup_percent: true },
      }),
    ]);
    const quote = await prisma.quote.create({
      data: {
        conversationId: conversation.id,
        userId: user.userId,
        companyId: user.companyId,
        templateId: activeTemplate?.id ?? null,
        markupPercent: config?.default_markup_percent ?? 0,
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

  /**
   * PATCH /api/v1/quotes/:quoteId — quote-level fields: the materials markup percentage and
   * the customer details (name/address/phone), each settable on the Invoice tab or stated in
   * the chat.
   *
   * Markup is stored as a percentage and applied on every read, never written into the line
   * items, so setting it re-prices every material line at once and any line added afterwards
   * picks it up with no extra action.
   *
   * Customer fields are free text with NO format validation (PRD is explicit) and fully
   * optional — null/empty clears a field, and a quote completes with any subset of them set.
   */
  static async updateQuote(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    if (quote.status === "COMPLETED") return fail(res, 409, "Quote is Completed and frozen");

    const body = req.body ?? {};
    const data: Record<string, unknown> = {};

    const { markupPercent } = body;
    if (markupPercent !== undefined) {
      if (typeof markupPercent !== "number" || !Number.isFinite(markupPercent))
        return fail(res, 400, "markupPercent must be a number");
      // Floored at 0 on purpose: a negative markup is a discount, and a percentage-off workflow
      // is an explicit non-goal — allowing it here would reopen that through a side door.
      if (markupPercent < 0) return fail(res, 400, "markupPercent cannot be negative");
      // Not a product sanity bound (there deliberately isn't one yet) — this is the column's own
      // limit, Decimal(5,2), rejected here so it fails with a message instead of a Prisma error.
      if (markupPercent > 999.99) return fail(res, 400, "markupPercent cannot exceed 999.99");
      data.markupPercent = markupPercent;
    }

    // Free text, no format validation. The length cap is a storage guard, not a format rule.
    for (const field of ["customerName", "customerAddress", "customerPhone"] as const) {
      if (body[field] === undefined) continue;
      if (body[field] !== null && typeof body[field] !== "string")
        return fail(res, 400, `${field} must be a string or null`);
      const value = body[field] == null ? null : body[field].trim().slice(0, 500);
      data[field] = value || null;
    }

    if (Object.keys(data).length === 0) return fail(res, 400, "Nothing to update");
    await prisma.quote.update({ where: { id: quote.id }, data });
    const updated = await loadOwnedQuote(quote.id, user.userId);
    res.json({ success: true, data: await quoteDtoWithProducts(updated!) });
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
    const isLabor = req.body?.isLabor === true;

    const manualPrice = unitPrice != null || totalPrice != null;
    // Prices in the UI are shown marked up and submitted as shown, but the column stores base
    // prices — divide the markup back out before it is stored (see stripMarkup).
    const markup = Number(quote.markupPercent ?? 0);
    const basePrice = (v: unknown) =>
      typeof v === "number" ? stripMarkup(v, markup, isLabor) : null;
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
        unitPrice: basePrice(unitPrice) ?? match?.unitPrice ?? null,
        totalPrice: basePrice(totalPrice),
        pricebookCode: match?.code ?? null,
        isLabor,
        sourcePricebookId: match?.sourcePricebookId ?? null,
        manuallyEdited: manualPrice,
        sortOrder: nextSort,
      },
    });
    res.status(201).json({
      success: true,
      // Marked up like every other read, or the new line would show a bare cost price until
      // the next full refetch of the quote.
      data: toLineItemDto(
        item,
        await catalogFor({ companyId: user.companyId, lineItems: [item] }),
        markup
      ),
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
    // A misclassified line is correctable here: markup skips labor, so getting this wrong is
    // the difference between a marked-up and a cost-price line.
    if (typeof body.isLabor === "boolean") data.isLabor = body.isLabor;
    // The price fields showed a marked-up figure and submit what they showed, so recover the
    // base price. `item.isLabor` is what the field was rendered from, even if this same request
    // also reclassifies the line.
    const toBase = (v: number) =>
      stripMarkup(v, Number(quote.markupPercent ?? 0), item.isLabor);
    if (typeof body.description === "string" && body.description !== item.description) {
      data.description = body.description;
      // Edited description on an unmatched, un-priced item → try matching again.
      if (!item.manuallyEdited && item.unitPrice == null && body.unitPrice == null) {
        const match = (await matcherFor(user.companyId))(body.description);
        data.pricebookCode = match?.code ?? null;
        data.unitPrice = match?.unitPrice ?? null;
        data.sourcePricebookId = match?.sourcePricebookId ?? null;
        if (match?.unit && body.unit == null && item.unit == null) data.unit = match.unit;
      }
    }
    if (body.quantity !== undefined) {
      // Labor hours must be greater than zero — the labor PRD's one sanity check (US7).
      if (item.isLabor && !(Number(body.quantity) > 0))
        return fail(res, 400, "Labor hours must be greater than zero");
      data.quantity = body.quantity;
    }
    if (body.unit !== undefined) data.unit = body.unit;
    // Per-line QBO item pick (QBO PRD US5). Both set together from the dropdown; null clears
    // back to auto (name match / create at post time).
    if (body.qboItemId !== undefined) {
      data.qboItemId = body.qboItemId == null ? null : String(body.qboItemId);
      data.qboItemName = body.qboItemName == null ? null : String(body.qboItemName);
    }
    // Manual price entry is used as-is, skips pricebook, and is flagged (US6).
    if (body.unitPrice !== undefined) {
      data.unitPrice = body.unitPrice == null ? null : toBase(body.unitPrice);
      data.manuallyEdited = true;
      data.sourcePricebookId = null; // the technician's own number has no book source
      // The technician's own number retires any web-search estimate.
      if (item.pricebookCode === ESTIMATED_PRICE_CODE) data.pricebookCode = null;
    }
    if (body.totalPrice !== undefined) {
      // not required to equal qty × unit price
      data.totalPrice = body.totalPrice == null ? null : toBase(body.totalPrice);
      data.manuallyEdited = true;
      data.sourcePricebookId = null;
      if (item.pricebookCode === ESTIMATED_PRICE_CODE) data.pricebookCode = null;
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
    // Caller-supplied term wins, then the line's stored catalog-shaped searchTerm, then the
    // prose description as a last resort (lines created before searchTerm was persisted).
    const term =
      typeof body.searchTerm === "string" && body.searchTerm.trim()
        ? body.searchTerm.trim()
        : item.searchTerm?.trim() || item.description;

    const matcher = await matcherFor(user.companyId);
    const match = matcher(term);
    // Live Home Depot lookup only when this client's fallback toggle is on (US5); with it
    // off, their own pricebooks are the only price source even for an explicit search.
    const resolved =
      match ?? (matcher.fallbackEnabled ? await resolveFromHomeDepot(term, user.companyId) : null);
    if (!resolved)
      return fail(
        res,
        404,
        matcher.fallbackEnabled
          ? `No catalog match for "${term}" — reword the description to a product name (size + part), or type a price.`
          : `No pricebook match for "${term}" — reword the description, type a price, or ask your office to add it to the pricebook.`
      );

    // A price only applies to a line whose unit measures the same thing — a per-EA spool
    // price must never multiply a line stated in feet (see packMath.unitsCompatible).
    if (item.unit && !unitsCompatible(item.unit, resolved.unit))
      return fail(
        res,
        404,
        `The catalog price for "${term}" is per ${resolved.unit ?? "each"}, which can't price a line measured in ${item.unit} — reword the description or type a price.`
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
        sourcePricebookId: match?.sourcePricebookId ?? null,
        manuallyEdited: false,
        ...(resolved.unit ? { unit: resolved.unit } : {}),
        ...(packed.rounded ? { quantity: packed.quantity } : {}),
      },
    });
    const updated = await loadOwnedQuote(quote.id, user.userId);
    res.json({ success: true, data: await quoteDtoWithProducts(updated!) });
  }

  /**
   * POST /api/v1/quotes/:quoteId/complete — gated on unresolved blocking flags (US6/US9).
   * Quotes with option groups must also carry the customer's choice (QBO PRD US3): the first
   * attempt without one returns 409 + code OPTION_CHOICE_REQUIRED and the options, the client
   * asks, and the retry carries body { chosenOption }. Completion then posts the estimate to
   * QBO in the background (QBO PRD US2) — never blocking, never failing the completion.
   */
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
    let chosenOption: string | null = quote.chosenOptionGroup;
    if (dto.optionTotals.length > 0) {
      const raw = req.body?.chosenOption;
      const submitted = typeof raw === "string" && raw.trim() ? raw.trim() : null;
      if (submitted) {
        if (!dto.optionTotals.some((o) => o.name === submitted))
          return fail(res, 400, `"${submitted}" is not one of this quote's options`);
        chosenOption = submitted;
      }
      if (!chosenOption)
        return res.status(409).json({
          success: false,
          error: {
            status: 409,
            code: "OPTION_CHOICE_REQUIRED",
            message: "This quote offers alternatives — confirm which option the customer chose",
            options: dto.optionTotals,
          },
        });
    }
    const updated = await prisma.quote.update({
      where: { id: quote.id },
      data: { status: "COMPLETED", completedAt: new Date(), chosenOptionGroup: chosenOption },
      include: { lineItems: true },
    });
    QuoteController.postToQboInBackground(updated);
    res.json({ success: true, data: await quoteDtoWithProducts(updated) });
  }

  /**
   * POST /api/v1/quotes/:quoteId/reopen — back to Draft; never touches line items (US9).
   * Clears the option choice so a re-completion asks again (QBO PRD US3/US6); the stored
   * qboEstimateId survives, which is what makes re-completion an update instead of a new post.
   */
  static async reopen(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    const updated = await prisma.quote.update({
      where: { id: quote.id },
      data: { status: "DRAFT", completedAt: null, chosenOptionGroup: null },
      include: { lineItems: true },
    });
    res.json({ success: true, data: await quoteDtoWithProducts(updated) });
  }

  /**
   * Fire-and-forget QBO post/update after completion (QBO PRD US2/US6). A failure is logged
   * and never surfaces to the completing technician — POST /:quoteId/qbo is the retry path.
   */
  private static postToQboInBackground(quote: NonNullable<Awaited<ReturnType<typeof loadOwnedQuote>>>) {
    void (async () => {
      const conn = await qboConnectionFor(quote.companyId);
      if (!qboConnected(conn)) return;
      const [dto, conversation] = await Promise.all([
        quoteDtoWithProducts(quote),
        prisma.conversation.findUnique({
          where: { id: quote.conversationId },
          select: { jobId: true },
        }),
      ]);
      const header = await loadQuoteHeader({
        jobId: conversation?.jobId,
        userId: quote.userId,
        companyId: quote.companyId,
      });
      await syncQuoteToQbo(conn, quote, dto, {
        name: quote.customerName ?? header.customerName,
        phone: quote.customerPhone,
        address: quote.customerAddress,
      });
    })().catch((e) =>
      logger.error("QBO estimate sync failed", {
        quoteId: quote.id,
        error: e instanceof Error ? e.message : String(e),
      })
    );
  }

  /**
   * GET /api/v1/quotes/:quoteId/images — the quote's directly-attached images, presigned.
   * Readable in any state: a Completed quote still SHOWS its frozen attachments.
   */
  static async listImages(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    res.json({ success: true, data: await quoteImagesDto(quote.conversationId) });
  }

  /**
   * POST /api/v1/quotes/:quoteId/images — attach images to the quote itself (PRD US6).
   * multipart field "images". A pure attach: the images NEVER reach the agent — no vision, no
   * captioning, no analysis of any kind. Standard formats stored as-is; no count limit beyond
   * the transport's 4-per-request (attach again for more).
   */
  static async uploadImages(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    if (quote.status === "COMPLETED") return fail(res, 409, "Quote is Completed and frozen");
    // imageUpload.array() puts an array here; the object shape belongs to .fields(), unused.
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) return fail(res, 400, "No images uploaded");

    const uploaded: { id: string; key: string; mimeType: string; filename: string; size: number }[] = [];
    for (const file of files) {
      // The document builders embed only JPEG/PNG (loadPhotos skips everything else), while
      // browsers happily render AVIF/WebP/etc — so a photo could show on the Invoice tab yet
      // silently vanish from the proposal. Convert anything else to JPEG at upload time; if
      // the codec is one sharp can't decode (some HEICs), store the original as-is — it still
      // displays in-app, and the doc-side skip is logged.
      let { buffer, mimetype } = file;
      let filename = file.originalname || "photo";
      if (!/^image\/(jpeg|png)$/i.test(mimetype)) {
        try {
          buffer = await sharp(buffer).rotate().jpeg({ quality: 85 }).toBuffer();
          mimetype = "image/jpeg";
          filename = filename.replace(/\.[^.]+$/, "") + ".jpg";
        } catch (err) {
          logger.warn("Quote image kept in original format (conversion failed)", {
            mimeType: file.mimetype,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const { key } = await uploadBufferToS3({
        key: `conversations/${quote.conversationId}/quote-images/${randomUUID()}-${filename}`,
        buffer,
        contentType: mimetype,
      });
      const row = await prisma.imageFile.create({
        data: {
          conversationId: quote.conversationId,
          messageId: null,
          s3Key: key,
          mimeType: mimetype,
          sizeBytes: BigInt(buffer.length),
          filename,
        },
      });
      uploaded.push({ id: row.id, key, mimeType: mimetype, filename, size: buffer.length });
    }

    // A visible record in the chat timeline — but ONLY a record: the ImageFile rows above keep
    // a null messageId (the quote gallery and doc queries key on that), and this message is
    // never fed to the agent as vision input. The attachments use the same JSON shape the
    // conversation upload flow stores, so the existing re-sign-on-read path renders them.
    await prisma.message.create({
      data: {
        conversationId: quote.conversationId,
        senderType: "USER",
        senderId: user.userId,
        content:
          uploaded.length === 1
            ? "Photo attached to the quote"
            : `${uploaded.length} photos attached to the quote`,
        contentType: "IMAGE",
        attachments: uploaded.map((u) => ({
          id: u.id,
          type: u.mimeType,
          filename: u.filename,
          size: u.size,
          metadata: { s3Key: u.key },
        })) as any,
      },
    });
    res.status(201).json({ success: true, data: await quoteImagesDto(quote.conversationId) });
  }

  /** DELETE /api/v1/quotes/:quoteId/images/:imageId — remove an attachment while Draft. */
  static async removeImage(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    if (quote.status === "COMPLETED") return fail(res, 409, "Quote is Completed and frozen");
    // Scoped to quote-attached rows: a chat-message image is part of the conversation record
    // and is not removable from here.
    const image = await prisma.imageFile.findFirst({
      where: {
        id: req.params.imageId as string,
        conversationId: quote.conversationId,
        messageId: null,
      },
    });
    if (!image) return fail(res, 404, "Image not found");
    await prisma.imageFile.delete({ where: { id: image.id } });
    res.json({ success: true, data: await quoteImagesDto(quote.conversationId) });
  }

  /**
   * GET /api/v1/quotes/:quoteId/docx — the quote document, rendered under the template
   * stamped on the quote at creation (default: the client-branded invoice).
   */
  static async downloadDocx(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    const dto = await quoteDtoWithProducts(quote);
    const buffer = await renderQuoteDocument(dto, quote.companyId, quote.templateId);
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
    const { input, proposalTemplate } = await buildProposalParts(quote);
    const buffer = await renderProposalDocx(input, proposalTemplate);
    const stamp = new Date().toISOString().slice(0, 10);
    res
      .setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
      .setHeader("Content-Disposition", `attachment; filename="proposal-${stamp}.docx"`)
      .send(buffer);
  }

  /** GET /api/v1/quotes/:quoteId/proposal-pdf — the same proposal rendered as a PDF. */
  static async downloadProposalPdf(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    const { input, proposalTemplate } = await buildProposalParts(quote);
    const buffer = await renderProposalPdf(input, proposalTemplate);
    const stamp = new Date().toISOString().slice(0, 10);
    res
      .setHeader("Content-Type", "application/pdf")
      .setHeader("Content-Disposition", `attachment; filename="proposal-${stamp}.pdf"`)
      .send(buffer);
  }

  /** GET /api/v1/quotes/:quoteId/email-draft — drafted proposal email for in-app review. */
  static async emailDraft(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    const [{ header, dto, projectTitle }, company] = await Promise.all([
      buildProposalParts(quote),
      prisma.companies.findUnique({
        where: { id: quote.companyId },
        select: { proposal_email_template: true },
      }),
    ]);
    const draft = draftProposalEmail({
      header,
      projectTitle,
      lineItems: dto.lineItems,
      total: dto.total,
      optionTotals: dto.optionTotals,
      template: company?.proposal_email_template,
    });
    res.json({
      success: true,
      data: { to: String(req.user?.email ?? ""), ...draft },
    });
  }

  /**
   * POST /api/v1/quotes/:quoteId/email — send the reviewed proposal email, PDF attached.
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

    const { header, input, proposalTemplate } = await buildProposalParts(quote);
    // Unpriced lines no longer block sending — the attached PDF prints them as visible
    // PENDING rows (estimate layout) or a red note (templated layout), which is the guard.
    const buffer = await renderProposalPdf(input, proposalTemplate);
    await sendEmail({
      to,
      from: SENDGRID_FROM_EMAIL,
      fromName: SENDGRID_FROM_NAME || header.companyName,
      ...(header.companyEmail ? { replyTo: header.companyEmail } : {}),
      subject,
      html: renderProposalHtml(header, body),
      text: body,
      attachment: {
        filename: `proposal-${new Date().toISOString().slice(0, 10)}.pdf`,
        content: buffer,
        type: "application/pdf",
      },
    });
    logger.info("Proposal emailed", { quoteId: quote.id, to });
    // Deliberately NO QuickBooks side effect here (QBO PRD US2): posting is tied to quote
    // completion, and emailing a proposal must never touch the books.
    res.json({ success: true, data: { sent: true, to } });
  }

  /**
   * POST /api/v1/quotes/:quoteId/qbo — retry a failed post (QBO PRD US8). Completed quotes
   * only: completion is the event that puts an estimate in QBO, so this re-runs exactly that
   * (creating or updating-in-place per US6).
   */
  static async syncQbo(req: RequestWithUser, res: Response) {
    const user = requireUser(req, res);
    if (!user) return;
    const quote = await loadOwnedQuote(req.params.quoteId as string, user.userId);
    if (!quote) return fail(res, 404, "Quote not found");
    if (quote.status !== "COMPLETED")
      return fail(res, 409, "Only a Completed quote posts to QuickBooks — mark it Completed first");
    const conn = await qboConnectionFor(quote.companyId);
    if (!qboConnected(conn))
      return fail(res, 409, "QuickBooks is not connected for this company");
    const conversation = await prisma.conversation.findUnique({
      where: { id: quote.conversationId },
      select: { jobId: true },
    });
    const header = await loadQuoteHeader({
      jobId: conversation?.jobId,
      userId: quote.userId,
      companyId: quote.companyId,
    });
    // Same precedence as the proposal: the quote's own customer fields beat the CRM header.
    const result = await syncQuoteToQbo(conn, quote, await quoteDtoWithProducts(quote), {
      name: quote.customerName ?? header.customerName,
      phone: quote.customerPhone,
      address: quote.customerAddress,
    });
    res.json({ success: true, data: result });
  }
}
