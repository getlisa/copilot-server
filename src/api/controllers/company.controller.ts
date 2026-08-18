import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { RequestWithUser } from "../middlewares/auth";
import { DEFAULT_PROPOSAL_EMAIL_TEMPLATE } from "../../copilot/estimating/proposalEmail";
import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { uploadBufferToS3, publicUrlForKey } from "../../lib/s3";

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
