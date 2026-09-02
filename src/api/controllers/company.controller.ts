import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { RequestWithUser } from "../middlewares/auth";
import { DEFAULT_PROPOSAL_EMAIL_TEMPLATE } from "../../copilot/estimating/proposalEmail";
import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { uploadBufferToS3, publicUrlForKey } from "../../lib/s3";
import {
  isQboConfigured,
  qboAuthUrl,
  qboConnectionFor,
  qboConnected,
  qboItems,
  saveQboCredentials,
} from "../../lib/qbo";

/**
 * Company registration (hidden page — reachable only by direct URL, no auth).
 * Creates the companies row that quote/proposal branding is read from, plus the
 * company's first (admin) user account. Passwords are bcrypt-hashed with the
 * same scheme the existing login service verifies ($2b$, cost 10).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const str = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s || null;
};

export class CompanyController {
  /** POST /api/v1/companies — multipart: company fields, admin-account fields, optional "logo" file. */
  static async create(req: Request, res: Response) {
    const b = req.body ?? {};
    const fail = (status: number, message: string) =>
      res.status(status).json({ success: false, error: { status, message } });

    const name = str(b.name);
    if (!name) return fail(400, "Company name is required");
    const email = str(b.email);
    if (email && !EMAIL_RE.test(email)) return fail(400, "Invalid company email address");

    // Admin account for the new company
    const firstName = str(b.firstName);
    const lastName = str(b.lastName);
    const accountEmail = str(b.accountEmail)?.toLowerCase() ?? null;
    const password = typeof b.password === "string" ? b.password : "";
    if (!firstName || !lastName) return fail(400, "Admin first and last name are required");
    if (!accountEmail || !EMAIL_RE.test(accountEmail))
      return fail(400, "A valid account email is required");
    if (password.length < 8) return fail(400, "Password must be at least 8 characters");
    const existing = await prisma.users.findUnique({ where: { email: accountEmail } });
    if (existing) return fail(409, "An account with this email already exists");

    let logoUrl: string | null = null;
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (file) {
      const ext = file.mimetype === "image/jpeg" ? "jpg" : "png";
      const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
      const key = `companies/logos/${Date.now()}-${safeName}.${ext}`;
      try {
        await uploadBufferToS3({ key, buffer: file.buffer, contentType: file.mimetype });
        // CDN URL when configured (never expires); otherwise store the S3 key —
        // the DOCX builder loads keys straight from S3, avoiding presign expiry.
        logoUrl = publicUrlForKey(key) ?? key;
      } catch (err) {
        logger.error("Company logo upload failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return res
          .status(502)
          .json({ success: false, error: { status: 502, message: "Logo upload failed — try again" } });
      }
    }

    const addressLine = str(b.address);
    // Service-location address, separate from the billing/mailing address above. Stored
    // whole-or-not-at-all; blank means "same as billing" (quoteHeader falls back).
    const serviceAddress = {
      line1: str(b.serviceAddress),
      city: str(b.serviceCity),
      state: str(b.serviceState),
      postal_code: str(b.servicePostalCode),
      country: str(b.serviceCountry),
    };
    const hasServiceAddress = Object.values(serviceAddress).some(Boolean);
    const hashedPassword = await bcrypt.hash(password, 10);
    const { company, user } = await prisma.$transaction(async (tx) => {
      const company = await tx.companies.create({
        data: {
          name,
          logo_url: logoUrl,
          phone: str(b.phone),
          email,
          license_number: str(b.licenseNumber),
          city: str(b.city),
          state: str(b.state),
          postal_code: str(b.postalCode),
          country: str(b.country),
          ...(addressLine ? { address: { line1: addressLine } } : {}),
          ...(hasServiceAddress ? { service_address: serviceAddress } : {}),
        },
      });
      const user = await tx.users.create({
        data: {
          first_name: firstName,
          last_name: lastName,
          email: accountEmail,
          username: accountEmail,
          hashed_password: hashedPassword,
          role: "admin",
          company_id: company.id,
        },
      });
      return { company, user };
    });

    logger.info("Company registered", {
      companyId: company.id,
      name: company.name,
      adminUserId: String(user.id),
    });
    res.status(201).json({
      success: true,
      data: {
        id: company.id,
        name: company.name,
        logoUrl: company.logo_url,
        adminEmail: user.email,
      },
    });
  }

  /**
   * GET /api/v1/companies/connections — integration status for the caller's company,
   * for the profile page's Connections section (QBO PRD US1). `connectUrl` is minted fresh
   * on every read (the signed state inside expires in 15 minutes), so the client re-fetches
   * at click time instead of caching it. Present whenever app keys exist — connecting again
   * deliberately replaces the old connection.
   */
  static async getConnections(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });
    const conn = await qboConnectionFor(companyId);
    res.json({
      success: true,
      data: {
        qbo: {
          configured: isQboConfigured(),
          hasCredentials: !!conn,
          connected: qboConnected(conn),
          realmId: conn?.realmId ?? null,
          environment: conn?.environment ?? "production",
          connectUrl: isQboConfigured() && conn ? qboAuthUrl(conn) : null,
        },
        // ponytail: ZenTrades is a display-only row in the UI for now; add a real entry
        // here when that integration exists.
      },
    });
  }

  /**
   * PUT /api/v1/companies/connections/qbo — save the company's QuickBooks app keys from the
   * Connections form (QBO PRD US1). Body: { clientId, clientSecret, environment? }. Replacing
   * keys clears any tokens issued under the old app, so the OAuth consent is redone next.
   */
  static async saveQboCredentials(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });
    if (!isQboConfigured())
      return res.status(503).json({
        success: false,
        error: { status: 503, message: "QBO_REDIRECT_URI is not set on the server" },
      });
    const clientId = str(req.body?.clientId);
    const clientSecret = str(req.body?.clientSecret);
    if (!clientId || !clientSecret)
      return res.status(400).json({
        success: false,
        error: { status: 400, message: "Both the Client ID and Client Secret are required" },
      });
    const environment = req.body?.environment === "sandbox" ? "sandbox" : "production";
    await saveQboCredentials(companyId, clientId, clientSecret, environment);
    logger.info("QBO app keys saved", { companyId, environment });
    return CompanyController.getConnections(req, res);
  }

  /**
   * GET /api/v1/companies/connections/qbo/items — the connected QBO account's item list, for
   * the per-line item dropdown (QBO PRD US5). 409 until the company is connected.
   */
  static async listQboItems(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });
    const conn = await qboConnectionFor(companyId);
    if (!qboConnected(conn))
      return res.status(409).json({
        success: false,
        error: { status: 409, message: "QuickBooks is not connected for this company" },
      });
    res.json({ success: true, data: await qboItems(conn) });
  }

  /**
   * GET/PUT /api/v1/companies/markup — the company default markup percentage (QBO PRD US7).
   * Applied as the starting markup of NEW quotes only; existing quotes keep their own.
   */
  static async getDefaultMarkup(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });
    const config = await prisma.company_configs.findUnique({
      where: { company_id: companyId },
      select: { default_markup_percent: true },
    });
    res.json({
      success: true,
      data: { defaultMarkupPercent: Number(config?.default_markup_percent ?? 0) },
    });
  }

  static async putDefaultMarkup(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });
    const n = Number(req.body?.defaultMarkupPercent);
    if (!Number.isFinite(n) || n < 0 || n > 999)
      return res.status(400).json({
        success: false,
        error: { status: 400, message: "defaultMarkupPercent must be a number between 0 and 999" },
      });
    const value = Math.round(n * 100) / 100;
    await prisma.company_configs.upsert({
      where: { company_id: companyId },
      // checklists is constrained to an ARRAY of {label, description} — [] is the empty state.
      create: { company_id: companyId, checklists: [], default_markup_percent: value },
      update: { default_markup_percent: value },
    });
    logger.info("Default markup updated", { companyId, value });
    res.json({ success: true, data: { defaultMarkupPercent: value } });
  }

  /** GET /api/v1/companies/proposal-email-template — the caller's company's template. */
  static async getProposalEmailTemplate(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });
    const company = await prisma.companies.findUnique({
      where: { id: companyId },
      select: { proposal_email_template: true },
    });
    res.json({
      success: true,
      data: {
        template: company?.proposal_email_template ?? null,
        // The editor prefills with this when no company template is saved yet.
        default: DEFAULT_PROPOSAL_EMAIL_TEMPLATE,
      },
    });
  }

  /**
   * PUT /api/v1/companies/proposal-email-template — body { template: string | null }.
   * Null/empty clears the override; the proposal email falls back to the built-in letter.
   */
  static async updateProposalEmailTemplate(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });
    const raw = req.body?.template;
    if (raw != null && typeof raw !== "string")
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "template must be a string or null" } });
    const template = raw?.trim() ? raw.slice(0, 10_000) : null;
    await prisma.companies.update({
      where: { id: companyId },
      data: { proposal_email_template: template },
    });
    logger.info("Proposal email template updated", { companyId, cleared: template == null });
    res.json({ success: true, data: { template } });
  }
}
