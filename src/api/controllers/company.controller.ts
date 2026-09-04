import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { RequestWithUser, isAdminRole } from "../middlewares/auth";
import { DEFAULT_PROPOSAL_EMAIL_TEMPLATE } from "../../copilot/estimating/proposalEmail";
import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { uploadBufferToS3, publicUrlForKey } from "../../lib/s3";
import {
  isQboConfigured,
  qboAuthUrl,
  qboConnectionFor,
  qboConnected,
  qboReconnectRequired,
  qboItems,
  connectQbo,
  disconnectQbo,
  companyIdFromState,
  QBO_ENVIRONMENT,
  QBO_APP_RETURN_URL,
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
   * GET /api/v1/companies/connections — integration status for the caller's company.
   * Readable by EVERY user of the company (product decision 2026-09-04): the Connections card
   * lives on the profile page and shows everyone whether QuickBooks is hooked up. Acting on it
   * — connect, disconnect — is admin-only and lives on separate routes.
   *
   * Deliberately carries NO auth URL. Minting one is a privileged action (see startQboConnect):
   * returning it from a read that every technician can call would let any of them bind their own
   * QuickBooks account to the company.
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
        /**
         * Whether THIS caller may connect or disconnect — decided here, from the role in the
         * verified JWT, and not by the client inspecting its own stored user object.
         *
         * The client cannot answer this reliably: it reads `role` from whatever the login
         * response happened to include, while the server reads it from the token. When those
         * disagree the client fails closed and hides the button from admins too, with no error
         * anywhere — which is exactly how a working feature looks broken.
         */
        canManage: isAdminRole(req.user?.role),
        qbo: {
          /** Server has the Intuit app keys, callback URL and token key set. */
          configured: isQboConfigured(),
          connected: qboConnected(conn),
          /** Tokens exist but were minted by the other Intuit keyset — reconnect, don't connect. */
          reconnectRequired: qboReconnectRequired(conn),
          realmId: conn?.realmId ?? null,
          /** The environment this SERVER runs against, not a per-company choice. */
          environment: QBO_ENVIRONMENT,
        },
        // ponytail: ZenTrades is a display-only row in the UI for now; add a real entry
        // here when that integration exists.
      },
    });
  }

  /**
   * POST /api/v1/companies/connections/qbo/connect — start the QuickBooks consent flow.
   * Admin-only, and scoped to the CALLER'S company: the returned URL carries a 15-minute signed
   * state naming that company, and whoever approves at Intuit has their QuickBooks bound to it.
   * That is why this is a POST behind requireAdmin rather than a field on the status read.
   * Minted fresh per click — the state expires — so the client must not cache it.
   */
  static async startQboConnect(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });
    if (!isQboConfigured())
      return res.status(503).json({
        success: false,
        error: { status: 503, message: "QuickBooks is not configured on this server" },
      });
    logger.info("QBO connect initiated", { companyId, environment: QBO_ENVIRONMENT });
    res.json({ success: true, data: { authUrl: qboAuthUrl(companyId) } });
  }

  /**
   * GET /api/v1/companies/connections/qbo/callback — Intuit's redirect target. Must match
   * QBO_REDIRECT_URI character-for-character and be registered on the Intuit app (separately for
   * the Development and Production keysets).
   *
   * Unauthenticated by necessity: Intuit sends the user's BROWSER here, with no bearer token.
   * The company is taken only from the signed state, never from a query param, so a forged or
   * expired callback cannot attach a QuickBooks account to someone else's company.
   */
  static async qboCallback(req: Request, res: Response) {
    const { code, state, realmId, error } = req.query as Record<string, string | undefined>;
    /**
     * Hand the browser back to the app's Connections page with the outcome, rather than leaving
     * the user parked on an API response. The page turns `?qbo=` into a toast and strips it.
     * Without QBO_APP_RETURN_URL configured, fall back to a confirmation page — a missing env
     * var should not strand the user mid-redirect.
     */
    const done = (outcome: "connected" | "error", message: string) => {
      if (QBO_APP_RETURN_URL) {
        const target = new URL(QBO_APP_RETURN_URL);
        target.searchParams.set("qbo", outcome);
        return res.redirect(target.toString());
      }
      return res.send(
        `<html><body style="font-family:system-ui;padding:2rem"><h3>${message}</h3><p>You can close this tab.</p></body></html>`
      );
    };
    if (error) {
      logger.warn("QBO callback returned an error", { error });
      return done("error", `QuickBooks returned: ${error}`);
    }
    const companyId = state ? companyIdFromState(state) : null;
    if (!companyId || !code || !realmId) {
      logger.warn("QBO callback rejected", { hasCode: !!code, hasRealm: !!realmId, hasState: !!state });
      return done("error", "That QuickBooks link was invalid or expired — start again from Connections.");
    }
    try {
      await connectQbo(companyId, code, realmId);
      logger.info("QBO connected", { companyId, realmId, environment: QBO_ENVIRONMENT });
      return done("connected", "QuickBooks connected.");
    } catch (e) {
      logger.error("QBO connect failed", {
        companyId,
        error: e instanceof Error ? e.message : String(e),
      });
      return done("error", "Could not finish connecting to QuickBooks. Please try again.");
    }
  }

  /**
   * DELETE /api/v1/companies/connections/qbo — forget this company's connection (US10 / D5).
   * Admin-only. Reconnecting later simply creates a fresh row.
   */
  static async disconnectQboForCompany(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });
    await disconnectQbo(companyId);
    logger.info("QBO disconnected", { companyId });
    return CompanyController.getConnections(req, res);
  }

  // DEFERRED (D1, 2026-09-04): PUT /companies/connections/qbo used to accept a per-company
  // Intuit Client ID + Secret here. Clara now owns the app and the keys come from server env,
  // so the endpoint is gone along with lib/qbo.ts::saveQboCredentials. The deferred design is
  // documented at the top of src/lib/qbo.ts; the frontend key form is commented out, not deleted.

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
