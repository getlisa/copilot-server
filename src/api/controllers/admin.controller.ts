import { Request, Response } from "express";
import prisma from "../../lib/prisma";
import { Prisma } from "@prisma/client";
import logger from "../../lib/logger";
import { uploadBufferToS3, publicUrlForKey } from "../../lib/s3";
import { parsePricebookFile, IngestError, ParsedRow } from "../../copilot/estimating/ingest";
import { repriceDrafts, repriceLaborDrafts } from "../../copilot/estimating/reprice";
import {
  DEFAULT_PROPOSAL_BLOCKS,
  blocksOrDefault,
  validateProposalBlocks,
} from "../../copilot/estimating/proposalTemplate";
import { renderProposalPdf } from "../../copilot/estimating/proposalEstimate";
import { importProposalDocument } from "../../copilot/estimating/proposalImportClassify";
import { ProposalImportError } from "../../copilot/estimating/proposalImport";
import type { ProposalInput } from "../../copilot/estimating/proposalDocx";
import { validateDocxTemplate } from "../../copilot/estimating/templates";

/**
 * Internal per-company configuration API (pricebook-config PRD + labor PRD): pricebooks,
 * branding, templates, Home Depot fallback toggle, labor rates, and conversation cleanup.
 * These routes are UNAUTHENTICATED, protected only by the non-obvious mount path in
 * server.ts (owner decision; the adminAuth/X-Admin-Token middleware was removed). Anyone
 * holding the URL can change any client's pricing, labor rates and templates — add real auth
 * before this is reachable by anyone outside the team.
 */

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ success: false, error: { status, message } });

const str = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s || null;
};

function companyIdOf(req: Request, res: Response): number | null {
  const id = Number(req.params.companyId);
  if (!Number.isInteger(id) || id <= 0) {
    fail(res, 400, "Numeric companyId required");
    return null;
  }
  return id;
}

/**
 * Item codes are unique per (companyId, code) across ALL of a company's books, so every
 * book-owned row is namespaced by its book id. A file's own code column is kept inside
 * that namespace; rows without one get their row number.
 */
const itemCode = (bookId: number, row: ParsedRow, index: number) =>
  `B${bookId}:${row.code ?? `R${index + 1}`}`;

async function insertRows(pricebookId: number, companyId: number, rows: ParsedRow[]) {
  const seen = new Set<string>();
  const duplicates: { line: number; reason: string }[] = [];
  const data = rows.flatMap((row, i) => {
    const code = itemCode(pricebookId, row, i);
    if (seen.has(code)) {
      duplicates.push({ line: i + 1, reason: `duplicate code "${row.code}"` });
      return [];
    }
    seen.add(code);
    return [
      {
        companyId,
        pricebookId,
        code,
        description: row.description,
        unit: row.unit ?? "EA",
        unitPrice: row.unitPrice,
        source: "MANUAL" as const,
      },
    ];
  });
  await prisma.pricebookItem.createMany({ data });
  return { inserted: data.length, duplicates };
}

export class AdminController {
  // ---------- companies ----------

  /** GET /admin/companies — picker list. */
  static async listCompanies(_req: Request, res: Response) {
    const companies = await prisma.companies.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    res.json({ success: true, data: companies });
  }

  /** GET /admin/companies/:companyId — branding + config + counts. */
  static async getCompany(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const [company, config, pricebookCount, laborRateCount] = await Promise.all([
      prisma.companies.findUnique({ where: { id: companyId } }),
      prisma.company_configs.findUnique({ where: { company_id: companyId } }),
      prisma.pricebook.count({ where: { companyId } }),
      prisma.laborRate.count({ where: { companyId } }),
    ]);
    if (!company) return fail(res, 404, "Company not found");
    res.json({
      success: true,
      data: {
        id: company.id,
        name: company.name,
        logoUrl: company.logo_url,
        phone: company.phone,
        email: company.email,
        licenseNumber: company.license_number,
        website: company.website,
        footerTerms: company.footer_terms,
        address: company.address,
        city: company.city,
        state: company.state,
        postalCode: company.postal_code,
        // Mirrors hdFallbackEnabledFor: no config row = fallback ON (the default).
        hdFallbackEnabled: config ? config.hd_fallback_enabled : true,
        pricebookCount,
        laborRateCount,
      },
    });
  }

  /**
   * PATCH /admin/companies/:companyId/config — branding fields, the fallback toggle, and
   * active-template assignment, in any combination.
   */
  static async patchConfig(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const company = await prisma.companies.findUnique({ where: { id: companyId } });
    if (!company) return fail(res, 404, "Company not found");
    const b = req.body ?? {};

    const companyData: Record<string, unknown> = {};
    if (b.name !== undefined) {
      const name = str(b.name);
      if (!name) return fail(res, 400, "Company name cannot be blank");
      companyData.name = name;
    }
    // Explicit null removes the logo; the templated proposal then prints none (there is
    // deliberately no Clara-logo fallback on that path).
    if (b.logoUrl === null) companyData.logo_url = null;
    if (b.phone !== undefined) companyData.phone = str(b.phone);
    if (b.email !== undefined) companyData.email = str(b.email);
    if (b.licenseNumber !== undefined) companyData.license_number = str(b.licenseNumber);
    if (b.website !== undefined) companyData.website = str(b.website);
    if (b.footerTerms !== undefined) companyData.footer_terms = str(b.footerTerms);
    if (b.city !== undefined) companyData.city = str(b.city);
    if (b.state !== undefined) companyData.state = str(b.state);
    if (b.postalCode !== undefined) companyData.postal_code = str(b.postalCode);
    if (b.address !== undefined) companyData.address = { line1: str(b.address) ?? "" };

    if (Object.keys(companyData).length > 0)
      await prisma.companies.update({ where: { id: companyId }, data: companyData });

    if (b.hdFallbackEnabled !== undefined) {
      const enabled = b.hdFallbackEnabled === true;
      await prisma.company_configs.upsert({
        where: { company_id: companyId },
        // checklists is constrained to an ARRAY of {label, description} — [] is the empty state.
        create: { company_id: companyId, checklists: [], hd_fallback_enabled: enabled },
        update: { hd_fallback_enabled: enabled },
      });
      logger.info("HD fallback toggled", { companyId, enabled });
    }

    if (b.activeTemplateId !== undefined) {
      if (b.activeTemplateId === null) {
        // Back to the built-in default invoice.
        await prisma.quoteTemplate.updateMany({
          where: { companyId },
          data: { isActive: false },
        });
      } else {
        const templateId = Number(b.activeTemplateId);
        const template = await prisma.quoteTemplate.findFirst({
          where: { id: templateId, companyId },
        });
        if (!template) return fail(res, 404, "Template not found for this company");
        // Exactly one active template per company (template-config PRD).
        await prisma.$transaction([
          prisma.quoteTemplate.updateMany({ where: { companyId }, data: { isActive: false } }),
          prisma.quoteTemplate.update({ where: { id: templateId }, data: { isActive: true } }),
        ]);
      }
    }

    return AdminController.getCompany(req, res);
  }

  /** POST /admin/companies/:companyId/logo — multipart "logo" image. */
  static async uploadLogo(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const company = await prisma.companies.findUnique({ where: { id: companyId } });
    if (!company) return fail(res, 404, "Company not found");
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) return fail(res, 400, "A logo image file is required");
    const ext = file.mimetype === "image/jpeg" ? "jpg" : "png";
    const safeName = company.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    const key = `companies/logos/${Date.now()}-${safeName}.${ext}`;
    try {
      await uploadBufferToS3({ key, buffer: file.buffer, contentType: file.mimetype });
    } catch (err) {
      logger.error("Admin logo upload failed", {
        companyId,
        error: err instanceof Error ? err.message : String(err),
      });
      return fail(res, 502, "Logo upload failed — try again");
    }
    const logoUrl = publicUrlForKey(key) ?? key;
    await prisma.companies.update({ where: { id: companyId }, data: { logo_url: logoUrl } });
    res.json({ success: true, data: { logoUrl } });
  }

  // ---------- pricebooks ----------

  /** GET /admin/companies/:companyId/pricebooks */
  static async listPricebooks(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const books = await prisma.pricebook.findMany({
      where: { companyId },
      orderBy: { priority: "asc" },
    });
    const counts = await prisma.pricebookItem.groupBy({
      by: ["pricebookId"],
      where: { pricebookId: { in: books.map((b) => b.id) } },
      _count: true,
    });
    const countBy = new Map(counts.map((c) => [c.pricebookId, c._count]));
    res.json({
      success: true,
      data: books.map((b) => ({
        id: b.id,
        name: b.name,
        priority: b.priority,
        sourceFormat: b.sourceFormat,
        originalFilename: b.originalFilename,
        itemCount: countBy.get(b.id) ?? 0,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
      })),
    });
  }

  /** POST /admin/companies/:companyId/pricebooks — multipart "file" + name + priority. */
  static async createPricebook(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const company = await prisma.companies.findUnique({ where: { id: companyId } });
    if (!company) return fail(res, 404, "Company not found");
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) return fail(res, 400, "A pricebook file is required (CSV, Excel, or PDF)");
    const name = str(req.body?.name);
    if (!name) return fail(res, 400, "A pricebook name is required");
    const priority = Number(req.body?.priority);
    if (!Number.isInteger(priority)) return fail(res, 400, "An integer priority is required");

    const siblings = await prisma.pricebook.findMany({ where: { companyId } });
    if (siblings.some((s) => s.name === name))
      return fail(res, 409, `This company already has a pricebook named "${name}"`);
    // No two books of one company may share a priority position (US1) — validated here
    // because reorders swap values, which a DB unique constraint would fight mid-update.
    if (siblings.some((s) => s.priority === priority))
      return fail(res, 409, `Priority ${priority} is already taken for this company`);

    let parsed;
    try {
      parsed = await parsePricebookFile(file.buffer, file.originalname);
    } catch (err) {
      if (err instanceof IngestError) return fail(res, 422, err.message);
      throw err;
    }
    if (parsed.rows.length === 0)
      return fail(
        res,
        422,
        `No valid rows in the file — all ${parsed.skipped.length} entries failed validation (item identifier present + numeric price)`
      );

    const book = await prisma.pricebook.create({
      data: {
        companyId,
        name,
        priority,
        sourceFormat: parsed.format,
        originalFilename: file.originalname,
      },
    });
    const { inserted, duplicates } = await insertRows(book.id, companyId, parsed.rows);
    const repriced = await repriceDrafts(companyId);
    logger.info("Pricebook created", { companyId, pricebookId: book.id, name, inserted });
    res.status(201).json({
      success: true,
      data: {
        pricebook: { id: book.id, name, priority, sourceFormat: parsed.format },
        ingested: inserted,
        skipped: [...parsed.skipped, ...duplicates],
        repricedDraftLines: repriced,
        columns: parsed.columns,
      },
    });
  }

  /** PUT /admin/pricebooks/:pricebookId/file — replace the book's contents (re-upload). */
  static async replacePricebookFile(req: Request, res: Response) {
    const pricebookId = Number(req.params.pricebookId);
    const book = await prisma.pricebook.findUnique({ where: { id: pricebookId } });
    if (!book) return fail(res, 404, "Pricebook not found");
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) return fail(res, 400, "A pricebook file is required (CSV, Excel, or PDF)");

    let parsed;
    try {
      parsed = await parsePricebookFile(file.buffer, file.originalname);
    } catch (err) {
      if (err instanceof IngestError) return fail(res, 422, err.message);
      throw err;
    }
    if (parsed.rows.length === 0)
      return fail(res, 422, "No valid rows in the file — the existing pricebook was left unchanged");

    await prisma.pricebookItem.deleteMany({ where: { pricebookId } });
    const { inserted, duplicates } = await insertRows(pricebookId, book.companyId, parsed.rows);
    await prisma.pricebook.update({
      where: { id: pricebookId },
      data: { sourceFormat: parsed.format, originalFilename: file.originalname },
    });
    // A replacement re-prices the company's open Drafts immediately (US1) — not on reopen.
    const repriced = await repriceDrafts(book.companyId);
    logger.info("Pricebook replaced", { pricebookId, inserted, repriced });
    res.json({
      success: true,
      data: {
        pricebook: { id: book.id, name: book.name, priority: book.priority, sourceFormat: parsed.format },
        ingested: inserted,
        skipped: [...parsed.skipped, ...duplicates],
        repricedDraftLines: repriced,
        columns: parsed.columns,
      },
    });
  }

  /** PATCH /admin/companies/:companyId/pricebooks/priorities — body {orders: [{id, priority}]}. */
  static async reorderPricebooks(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const orders: { id: number; priority: number }[] = Array.isArray(req.body?.orders)
      ? req.body.orders
      : [];
    if (orders.length === 0) return fail(res, 400, "orders: [{id, priority}] is required");
    if (orders.some((o) => !Number.isInteger(o?.id) || !Number.isInteger(o?.priority)))
      return fail(res, 400, "Every order entry needs an integer id and priority");
    const priorities = orders.map((o) => o.priority);
    if (new Set(priorities).size !== priorities.length)
      return fail(res, 409, "Priorities must be unique per company");

    const books = await prisma.pricebook.findMany({ where: { companyId } });
    const bookIds = new Set(books.map((b) => b.id));
    if (orders.some((o) => !bookIds.has(o.id)))
      return fail(res, 404, "One or more pricebook ids do not belong to this company");
    if (orders.length !== books.length)
      return fail(res, 400, "Provide a priority for every one of the company's pricebooks");

    await prisma.$transaction(
      orders.map((o) =>
        prisma.pricebook.update({ where: { id: o.id }, data: { priority: o.priority } })
      )
    );
    // A priority-order change re-prices open Drafts immediately (US1).
    const repriced = await repriceDrafts(companyId);
    res.json({ success: true, data: { repricedDraftLines: repriced } });
  }

  /** DELETE /admin/pricebooks/:pricebookId */
  static async deletePricebook(req: Request, res: Response) {
    const pricebookId = Number(req.params.pricebookId);
    const book = await prisma.pricebook.findUnique({ where: { id: pricebookId } });
    if (!book) return fail(res, 404, "Pricebook not found");
    await prisma.$transaction([
      prisma.pricebookItem.deleteMany({ where: { pricebookId } }),
      prisma.pricebook.delete({ where: { id: pricebookId } }),
    ]);
    const repriced = await repriceDrafts(book.companyId);
    logger.info("Pricebook deleted", { pricebookId, companyId: book.companyId, repriced });
    res.json({ success: true, data: { repricedDraftLines: repriced } });
  }

  // ---------- labor rates ----------

  /** GET /admin/companies/:companyId/labor-rates */
  static async listLaborRates(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const rates = await prisma.laborRate.findMany({
      where: { companyId },
      orderBy: { name: "asc" },
    });
    res.json({
      success: true,
      data: rates.map((r) => ({ id: r.id, name: r.name, hourlyRate: Number(r.hourlyRate) })),
    });
  }

  /** POST /admin/companies/:companyId/labor-rates — {name, hourlyRate}. $0 is valid. */
  static async createLaborRate(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const name = str(req.body?.name);
    if (!name) return fail(res, 400, "A labor type name is required");
    const hourlyRate = Number(req.body?.hourlyRate);
    if (!Number.isFinite(hourlyRate) || hourlyRate < 0)
      return fail(res, 400, "hourlyRate must be zero or a positive number");
    const existing = await prisma.laborRate.findFirst({ where: { companyId, name } });
    if (existing) return fail(res, 409, `This company already has a labor type named "${name}"`);
    const rate = await prisma.laborRate.create({ data: { companyId, name, hourlyRate } });
    res.status(201).json({
      success: true,
      data: { id: rate.id, name: rate.name, hourlyRate: Number(rate.hourlyRate) },
    });
  }

  /** PATCH /admin/labor-rates/:id — {name?, hourlyRate?}. Re-prices open Drafts (US8). */
  static async updateLaborRate(req: Request, res: Response) {
    const id = Number(req.params.id);
    const rate = await prisma.laborRate.findUnique({ where: { id } });
    if (!rate) return fail(res, 404, "Labor rate not found");
    const data: Record<string, unknown> = {};
    if (req.body?.name !== undefined) {
      const name = str(req.body.name);
      if (!name) return fail(res, 400, "A labor type name cannot be blank");
      const clash = await prisma.laborRate.findFirst({
        where: { companyId: rate.companyId, name, id: { not: id } },
      });
      if (clash) return fail(res, 409, `This company already has a labor type named "${name}"`);
      data.name = name;
    }
    if (req.body?.hourlyRate !== undefined) {
      const hourlyRate = Number(req.body.hourlyRate);
      if (!Number.isFinite(hourlyRate) || hourlyRate < 0)
        return fail(res, 400, "hourlyRate must be zero or a positive number");
      data.hourlyRate = hourlyRate;
    }
    if (Object.keys(data).length === 0) return fail(res, 400, "Nothing to update");
    const updated = await prisma.laborRate.update({ where: { id }, data });
    const repriced = await repriceLaborDrafts(rate.companyId);
    res.json({
      success: true,
      data: {
        id: updated.id,
        name: updated.name,
        hourlyRate: Number(updated.hourlyRate),
        repricedDraftLines: repriced,
      },
    });
  }

  /** DELETE /admin/labor-rates/:id — detaches (never deletes) any Draft lines using it. */
  static async deleteLaborRate(req: Request, res: Response) {
    const id = Number(req.params.id);
    const rate = await prisma.laborRate.findUnique({ where: { id } });
    if (!rate) return fail(res, 404, "Labor rate not found");
    await prisma.laborRate.delete({ where: { id } });
    const repriced = await repriceLaborDrafts(rate.companyId);
    res.json({ success: true, data: { repricedDraftLines: repriced } });
  }

  // ---------- templates ----------

  /** GET /admin/companies/:companyId/templates */
  static async listTemplates(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const templates = await prisma.quoteTemplate.findMany({
      where: { companyId },
      orderBy: { createdAt: "asc" },
    });
    res.json({ success: true, data: templates });
  }

  /**
   * POST /admin/companies/:companyId/templates — multipart: "file" (a .docx template
   * using the placeholders documented in the admin UI) + name. The template is
   * compile-checked at upload so a broken tag is rejected here, not on a technician's
   * download. Without a file, a bare row can still be created for a code renderer
   * ({name, renderer}).
   */
  static async createTemplate(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const company = await prisma.companies.findUnique({ where: { id: companyId } });
    if (!company) return fail(res, 404, "Company not found");
    const name = str(req.body?.name);
    if (!name) return fail(res, 400, "A template name is required");

    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (file) {
      if (!file.originalname.toLowerCase().endsWith(".docx"))
        return fail(res, 422, "A template must be a .docx Word file");
      const problem = validateDocxTemplate(file.buffer);
      if (problem) return fail(res, 422, `Template has invalid placeholders: ${problem}`);
      const key = `companies/templates/${companyId}/${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
      try {
        await uploadBufferToS3({
          key,
          buffer: file.buffer,
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
      } catch (err) {
        logger.error("Template upload to S3 failed", {
          companyId,
          error: err instanceof Error ? err.message : String(err),
        });
        return fail(res, 502, "Template upload failed — try again");
      }
      const template = await prisma.quoteTemplate.create({
        data: {
          companyId,
          name,
          renderer: "docx",
          config: { s3Key: key, originalFilename: file.originalname },
        },
      });
      logger.info("Custom docx template uploaded", { companyId, templateId: template.id, name });
      return res.status(201).json({ success: true, data: template });
    }

    const renderer = str(req.body?.renderer) ?? "invoice";
    const template = await prisma.quoteTemplate.create({
      data: {
        companyId,
        name,
        renderer,
        config: req.body?.config && typeof req.body.config === "object" ? req.body.config : {},
      },
    });
    res.status(201).json({ success: true, data: template });
  }

  /**
   * DELETE /admin/templates/:id — removes the template row. Quotes stamped with it keep
   * their stamp and fall back to the default invoice at render time; new quotes stop
   * using it (if it was active, the company reverts to the default).
   */
  static async deleteTemplate(req: Request, res: Response) {
    const id = Number(req.params.id);
    const template = await prisma.quoteTemplate.findUnique({ where: { id } });
    if (!template) return fail(res, 404, "Template not found");
    await prisma.quoteTemplate.delete({ where: { id } });
    logger.info("Template deleted", { templateId: id, companyId: template.companyId });
    res.json({ success: true, data: { deleted: true } });
  }

  // ---------- conversations (estimate chats) ----------

  /** GET /admin/companies/:companyId/conversations — the company's estimate chats. */
  static async listConversations(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const quotes = await prisma.quote.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      include: {
        lineItems: { select: { id: true } },
        conversation: {
          select: {
            messages: {
              where: { senderType: "USER" },
              orderBy: { createdAt: "asc" },
              take: 1,
              select: { content: true },
            },
          },
        },
      },
    });
    res.json({
      success: true,
      data: quotes.map((q) => ({
        quoteId: q.id,
        conversationId: q.conversationId,
        status: q.status,
        lineItemCount: q.lineItems.length,
        firstMessage: q.conversation?.messages[0]?.content.slice(0, 120) ?? null,
        createdAt: q.createdAt,
        updatedAt: q.updatedAt,
      })),
    });
  }

  /**
   * DELETE /admin/companies/:companyId/conversations — body {quoteIds: [], includeCompleted?}.
   * Deleting a conversation cascades to its messages, quote, and line items. Permanent.
   * Completed quotes are refused unless includeCompleted is explicitly true.
   */
  static async deleteConversations(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const quoteIds: string[] = Array.isArray(req.body?.quoteIds)
      ? req.body.quoteIds.filter((id: unknown) => typeof id === "string")
      : [];
    if (quoteIds.length === 0) return fail(res, 400, "quoteIds: [] is required");
    const includeCompleted = req.body?.includeCompleted === true;

    // Company-scoped lookup: an id belonging to another company is rejected, not deleted.
    const quotes = await prisma.quote.findMany({
      where: { id: { in: quoteIds }, companyId },
      select: { id: true, conversationId: true, status: true },
    });
    if (quotes.length !== quoteIds.length)
      return fail(res, 404, "One or more quotes were not found for this company");
    const refused = includeCompleted ? [] : quotes.filter((q) => q.status === "COMPLETED");
    if (refused.length > 0)
      return fail(
        res,
        409,
        `${refused.length} of the selected quotes are Completed — pass includeCompleted: true to delete them too`
      );

    const result = await prisma.conversation.deleteMany({
      where: { id: { in: quotes.map((q) => q.conversationId) } },
    });
    logger.info("Admin deleted estimate conversations", {
      companyId,
      deleted: result.count,
      includeCompleted,
    });
    res.json({ success: true, data: { deleted: result.count } });
  }

  // ---------- proposal document format ----------

  /**
   * Representative quote data for the preview, so the admin sees a realistic document without
   * needing a real quote to exist for the company. Deliberately obvious sample values: a
   * preview must never be mistaken for a customer's actual proposal.
   */
  private static previewInput(company: {
    name: string;
    logo_url: string | null;
    phone: string | null;
    email: string | null;
    license_number: string | null;
  }): ProposalInput {
    return {
      header: {
        companyName: company.name,
        companyAddress: "",
        companyPhone: company.phone ?? "",
        companyEmail: company.email ?? "",
        customerName: "SAMPLE CUSTOMER",
        billingAddress: "123 Sample Street",
        serviceAddress: "123 Sample Street",
        technicianName: "Sample Technician",
        logoUrl: company.logo_url,
        licenseNumber: company.license_number ?? "",
      },
      projectTitle: "Sample Project — Preview Only",
      date: new Date(),
      // Sample rows so the editor's preview shows the lineItems table the default ships with.
      lineItems: [
        { code: "LB-020", description: "Minimum Service Call", quantity: 1, unit: "CALL", unitPrice: 175, totalPrice: 175, priceSource: "Labor Rates" },
        { code: "SMP-001", description: "Sample material line item", quantity: 2, unit: "EA", unitPrice: 25, totalPrice: 50, priceSource: "Company pricebook" },
        { description: "Sample labor line", quantity: 0.5, unit: "HR", unitPrice: 75, totalPrice: 37.5, isLabor: true },
      ],
      scopeSections: [
        {
          title: "Sample Work Area",
          bullets: [
            "Sample task describing the work to be performed",
            "Test and verify proper operation upon completion",
          ],
        },
      ],
      total: 262.5,
      unpricedCount: 0,
    };
  }

  /** GET /admin/companies/:companyId/proposal-template — stored blocks, or the default. */
  static async getProposalTemplate(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const company = await prisma.companies.findUnique({
      where: { id: companyId },
      select: { proposal_template: true },
    });
    if (!company) return fail(res, 404, "Company not found");
    res.json({
      success: true,
      data: {
        // `isDefault` lets the UI say "you are on the standard proposal" rather than implying
        // the company has already customised it.
        isDefault: company.proposal_template == null,
        blocks: blocksOrDefault(company.proposal_template),
      },
    });
  }

  /**
   * PUT /admin/companies/:companyId/proposal-template — save the edited blocks.
   * Validated here so a broken format can never reach a technician's download; the renderer
   * also falls back defensively, but a save is the right place to refuse it with a reason.
   */
  static async putProposalTemplate(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const company = await prisma.companies.findUnique({ where: { id: companyId } });
    if (!company) return fail(res, 404, "Company not found");
    const blocks = req.body?.blocks;
    const problems = validateProposalBlocks(blocks);
    if (problems.length > 0)
      return fail(res, 422, `Proposal format is not valid: ${problems.slice(0, 4).join("; ")}`);
    await prisma.companies.update({
      where: { id: companyId },
      data: { proposal_template: blocks as Prisma.InputJsonValue },
    });
    logger.info("Proposal format saved", { companyId, blocks: (blocks as unknown[]).length });
    res.json({ success: true, data: { isDefault: false, blocks } });
  }

  /** DELETE /admin/companies/:companyId/proposal-template — back to the standard proposal. */
  static async deleteProposalTemplate(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const company = await prisma.companies.findUnique({ where: { id: companyId } });
    if (!company) return fail(res, 404, "Company not found");
    await prisma.companies.update({
      where: { id: companyId },
      // DbNull writes a real SQL NULL; JsonNull would store the JSON value `null`,
      // which reads back as "customised" rather than "on the standard proposal".
      data: { proposal_template: Prisma.DbNull },
    });
    logger.info("Proposal format reset to the standard proposal", { companyId });
    res.json({ success: true, data: { isDefault: true, blocks: DEFAULT_PROPOSAL_BLOCKS } });
  }

  /**
   * POST /admin/companies/:companyId/proposal-template/import — multipart "file" (.docx or
   * .pdf). Returns the parsed blocks and any warnings WITHOUT saving: the admin reviews and
   * corrects them in the editor first, which is the whole point of an LLM-assisted import.
   */
  static async importProposalTemplate(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const company = await prisma.companies.findUnique({ where: { id: companyId } });
    if (!company) return fail(res, 404, "Company not found");
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) return fail(res, 400, "A .docx or .pdf proposal document is required");
    try {
      const { blocks, warnings } = await importProposalDocument(file.buffer, file.originalname);
      logger.info("Proposal document imported", {
        companyId,
        filename: file.originalname,
        blocks: blocks.length,
        warnings: warnings.length,
      });
      res.json({ success: true, data: { blocks, warnings, saved: false } });
    } catch (err) {
      if (err instanceof ProposalImportError) return fail(res, 422, err.message);
      logger.error("Proposal import failed", {
        companyId,
        error: err instanceof Error ? err.message : String(err),
      });
      return fail(res, 502, "Could not read that document — try a different file");
    }
  }

  /**
   * POST /admin/companies/:companyId/proposal-template/preview — render blocks to a PDF.
   * Takes blocks from the body so the editor can preview UNSAVED edits; falls back to the
   * stored format when the body has none.
   */
  static async previewProposalTemplate(req: Request, res: Response) {
    const companyId = companyIdOf(req, res);
    if (!companyId) return;
    const company = await prisma.companies.findUnique({ where: { id: companyId } });
    if (!company) return fail(res, 404, "Company not found");
    const submitted = req.body?.blocks;
    if (submitted !== undefined) {
      const problems = validateProposalBlocks(submitted);
      if (problems.length > 0)
        return fail(res, 422, `Cannot preview: ${problems.slice(0, 4).join("; ")}`);
    }
    const blocks = submitted ?? company.proposal_template;
    try {
      // The dispatcher previews what technicians actually get: no stored/edited blocks →
      // the job feature's estimate document; edited blocks → the templated layout.
      const buffer = await renderProposalPdf(AdminController.previewInput(company), blocks);
      res
        .setHeader("Content-Type", "application/pdf")
        .setHeader("Content-Disposition", 'inline; filename="proposal-preview.pdf"')
        .send(buffer);
    } catch (err) {
      logger.error("Proposal preview render failed", {
        companyId,
        error: err instanceof Error ? err.message : String(err),
      });
      return fail(res, 500, "Could not render a preview of this format");
    }
  }
}
