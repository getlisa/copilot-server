import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { RequestWithUser, isAdminRole } from "../middlewares/auth";
import { DEFAULT_PROPOSAL_EMAIL_TEMPLATE } from "../../copilot/estimating/proposalEmail";
import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { clientSafeMessage } from "../../lib/clientError";
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
import {
  syncQboReferenceData,
  QboSyncBusyError,
  searchCustomers,
  qboIncomeAccounts,
  listSalesTax,
  setDefaultSalesTax,
  setSalesTaxActive,
  taxEnabledFor,
  upsertSalesTax,
  parseRatePercent,
  qboSyncedAt,
  createCustomer,
} from "../../lib/qboIngest";

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
          /** When reference data was last pulled; null means never. Drives the Sync button. */
          referenceSyncedAt: (await qboSyncedAt(companyId))?.toISOString() ?? null,
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
   * POST /api/v1/companies/connections/qbo/sync — pull QuickBooks reference data (customers,
   * items, tax codes, tax rates, accounts) into the raw_<entity>_qb tables. Admin-only: it is a
   * write, it costs API quota against an app shared by every client, and it is a settings action.
   *
   * Synchronous on purpose. It is admin-initiated and the admin wants to see the counts; a
   * background job here would only add a status endpoint to build and a silent failure to miss.
   */
  static async syncQboData(req: RequestWithUser, res: Response) {
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
    try {
      const counts = await syncQboReferenceData(companyId);
      res.json({ success: true, data: { counts, syncedAt: new Date().toISOString() } });
    } catch (e) {
      // "Already running" is not "QuickBooks is unreachable", and the difference became
      // user-visible when the webhook drain started competing for this same claim every ten
      // seconds instead of only when another admin clicked. Flattening it into the 502 below told
      // people their accounting system was down when it was simply busy. 409 matches what this
      // endpoint already returns for its other not-ready state.
      if (e instanceof QboSyncBusyError) {
        logger.info("QBO reference sync skipped: already running", { companyId });
        return res.status(409).json({
          success: false,
          error: { status: 409, message: e.message },
        });
      }
      logger.error("QBO reference sync failed", {
        companyId,
        error: e instanceof Error ? e.message : String(e),
      });
      res.status(502).json({
        success: false,
        error: { status: 502, message: "Could not read from QuickBooks. Please try again." },
      });
    }
  }

  /**
   * GET /api/v1/companies/qbo/customers?q= — customer typeahead for the estimate screen.
   *
   * Open to every role, like the item list: a technician picking the customer on a quote needs
   * it, and gating it would empty the picker with no error anywhere. Reads the local mirror, not
   * Intuit — a keystroke must not become an API call, and the picker must keep working when
   * QuickBooks is down. A company with no connection simply gets an empty list, which is what
   * lets the UI fall back to "add as new customer".
   */
  static async listQboCustomers(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const limit = Number(req.query.limit);
    // The connected realm scopes which QuickBooks ids are meaningful; null when disconnected,
    // in which case every customer simply reports qboId null rather than a stale one.
    const conn = await qboConnectionFor(companyId);
    const realmId = qboConnected(conn) ? conn.realmId : null;
    res.json({
      success: true,
      data: await searchCustomers(companyId, q, Number.isFinite(limit) ? limit : 20, realmId),
    });
  }

  /**
   * POST /api/v1/companies/qbo/customers — create a customer in QuickBooks and mirror it.
   *
   * The other half of the estimate screen's picker: choose an existing customer, or add a new one
   * and sync it. A customer must exist in QuickBooks before the estimate that bills to it can be
   * posted, so this is what makes "add new" usable mid-quote rather than a settings chore.
   *
   * Open to every role, deliberately. A technician standing in a new customer's kitchen is
   * exactly who needs it; requiring an admin would mean the estimate cannot be posted until
   * someone back at the office logs in.
   */
  static async createQboCustomerForCompany(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });
    // No connection guard: a company with no accounting integration still needs customers, and
    // createCustomer takes a null connection deliberately. Guarding here made the client's
    // "added (not to QuickBooks)" branch unreachable and blocked customer creation outright for
    // any company that has not connected.
    const conn = await qboConnectionFor(companyId);
    const name = str(req.body?.name);
    if (!name)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "A customer name is required" } });
    try {
      // parentId makes this a sub-customer (a Job in QuickBooks). An unparseable value is
      // treated as absent rather than rejected: the field is optional, and "0" or "" from a
      // form should mean "no parent", not a 400 the technician cannot interpret.
      const rawParent = Number(req.body?.parentId);
      const parentId = Number.isInteger(rawParent) && rawParent > 0 ? rawParent : null;
      const created = await createCustomer(companyId, {
        name,
        email: str(req.body?.email),
        phone: str(req.body?.phone),
        address: str(req.body?.address),
        parentId,
      }, qboConnected(conn) ? conn : null);
      res.status(201).json({ success: true, data: created });
    } catch (e) {
      // Only messages this codebase wrote for the person on site come back — a duplicate name
      // or a bad email is theirs to fix. An Intuit fault body or a Prisma constraint message is
      // logged and replaced (T-53): it carries realm ids and schema detail, and tells them
      // nothing they can act on.
      const message = clientSafeMessage(e, "Could not create the customer — please try again");
      logger.warn("QBO customer create refused", {
        companyId,
        message,
        error: e instanceof Error ? e.message : String(e),
      });
      res.status(400).json({ success: false, error: { status: 400, message } });
    }
  }

  /**
   * GET /api/v1/companies/qbo/income-accounts — so an admin chooses the revenue account CLARA
   * bills auto-created items against, instead of the code taking whichever Income account
   * QuickBooks happened to return first.
   */
  static async listQboIncomeAccounts(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });
    res.json({ success: true, data: await qboIncomeAccounts(companyId) });
  }

  /**
   * GET /api/v1/companies/qbo/tax-rates — the company's QuickBooks tax rates, offered as a
   * pre-fill for the organisation's default rate so an admin imports it rather than typing it.
   * A pre-fill only: CLARA computes tax from its OWN setting, never from this list.
   */
  static async listSalesTaxRates(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });
    const { taxSource, taxEnabled, taxEnforced, taxEnforcedBy, rates } = await listSalesTax(companyId);
    res.json({
      success: true,
      data: {
        /** "quickbooks" | "crm" | "manual" — where this company's tax comes from. */
        taxSource,
        /** Whether tax applies at all. False means new estimates start with no rate. */
        taxEnabled,
        /** True when a connection forces it on, so the screen locks the switch and says why. */
        taxEnforced,
        /** "quickbooks" | "crm" | null — which one, so the reason names the right system. */
        taxEnforcedBy,
        rates: rates.map((r) => ({ ...r, ratePercent: Number(r.ratePercent) })),
      },
    });
  }

  /**
   * POST /api/v1/companies/sales-tax — add or update a sales-tax rate (settings → tax settings).
   * Admin-only: this rate is applied to money on customer-facing estimates.
   *
   * Body: { id?, name, ratePercent, isActive?, isDefault? }. Passing an id updates that rate;
   * omitting it creates one. Setting isDefault moves the default — exactly one rate per company
   * can hold it.
   */
  static async saveSalesTax(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });

    const name = str(req.body?.name);
    if (!name)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "A rate name is required" } });

    // 0 is allowed and meaningful — a deliberate zero-rate jurisdiction is not the same as
    // having no rate configured. Anything that is not a rate (null, "", []) is rejected rather
    // than coerced to 0, which is what `Number()` used to do here.
    const rate = parseRatePercent(req.body?.ratePercent);
    if (rate == null)
      return res.status(400).json({
        success: false,
        error: { status: 400, message: "ratePercent must be a number between 0 and 99.9999" },
      });

    try {
      const rawId = req.body?.id == null ? null : Number(req.body.id);
      if (rawId !== null && !Number.isInteger(rawId))
        return res
          .status(400)
          .json({ success: false, error: { status: 400, message: "id must be an integer or null" } });
      const saved = await upsertSalesTax(
        companyId,
        {
          id: rawId,
          name,
          ratePercent: rate,
          // Undefined stays undefined: an edit that omits these must not clear them. Sending
          // `isDefault: false` by omission silently removed the company's default, after which
          // every new estimate started untaxed with nothing on screen to say so.
          isActive: req.body?.isActive === undefined ? undefined : req.body.isActive !== false,
          isDefault: req.body?.isDefault === undefined ? undefined : req.body.isDefault === true,
        },
        // Attributed to the admin who did it — createdBy/updatedBy exist so a rate applied to
        // customer money is traceable to a person.
        req.user?.userId == null ? null : BigInt(req.user.userId)
      );
      logger.info("Sales tax saved", { companyId, id: saved.id, isDefault: saved.isDefault });
      res.json({ success: true, data: { ...saved, ratePercent: Number(saved.ratePercent) } });
    } catch (e) {
      const message = clientSafeMessage(e, "Could not save the rate");
      // 409 when the company's state forbids it (tax comes from a connected system); 400 when
      // the request itself is at fault. The client shows the message either way, but the status
      // is what tells it apart.
      const status = /comes from QuickBooks/i.test(message) ? 409 : 400;
      res.status(status).json({ success: false, error: { status, message } });
    }
  }

  /**
   * PUT /api/v1/companies/tax-enabled — whether sales tax applies to this company at all.
   * Body: { taxEnabled }
   *
   * Refused while QuickBooks OR a CRM is connected, in both directions. Either connection forces
   * it on, for the same underlying reason: the company invoices through a system that charges tax,
   * so an estimate declaring none would disagree with what that system bills for the same job.
   * Accepting the write and then ignoring it — which is what returning the computed value would
   * amount to — is the failure mode this whole area has been bitten by before, so it 409s with the
   * reason, and `enforcedBy` decides which system the message names.
   */
  static async setTaxEnabled(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });
    // Strict, not truthy: a body of { taxEnabled: "false" } must not switch tax ON.
    if (typeof req.body?.taxEnabled !== "boolean")
      return res.status(400).json({
        success: false,
        error: { status: 400, message: "taxEnabled must be true or false" },
      });
    const { enforced, enforcedBy } = await taxEnabledFor(companyId);
    if (enforced) {
      /**
       * Name the integration that is actually forcing it. The message used to say QuickBooks
       * unconditionally, which was wrong for a CRM company in both halves: not QuickBooks, and
       * their rates do NOT come from there — nothing ingests tax from a CRM, so they type their
       * own. Being told to go and change something in a system that does not hold it is worse
       * than a generic refusal.
       */
      const message =
        enforcedBy === "quickbooks"
          ? "Sales tax stays on while QuickBooks is connected — your rates and tax codes come from there."
          : "Sales tax stays on while your CRM is connected, because jobs are invoiced through it. You can still choose which rate applies below.";
      logger.info("Tax enabled change refused", { companyId, enforcedBy, requested: req.body.taxEnabled });
      return res.status(409).json({ success: false, error: { status: 409, message } });
    }
    await prisma.company_configs.upsert({
      where: { company_id: companyId },
      // checklists is constrained to an ARRAY of {label, description} — [] is the empty state.
      create: { company_id: companyId, checklists: [], tax_enabled: req.body.taxEnabled },
      update: { tax_enabled: req.body.taxEnabled },
    });
    logger.info("Tax enabled changed", { companyId, taxEnabled: req.body.taxEnabled });
    const { taxSource, taxEnabled, taxEnforced, taxEnforcedBy, rates } = await listSalesTax(companyId);
    res.json({
      success: true,
      data: {
        taxSource,
        taxEnabled,
        taxEnforced,
        taxEnforcedBy,
        rates: rates.map((r) => ({ ...r, ratePercent: Number(r.ratePercent) })),
      },
    });
  }

  /**
   * PUT /api/v1/companies/sales-tax/:id/active — offer this rate, or stop offering it.
   * Body: { isActive }
   *
   * Separate from `saveSalesTax` because that endpoint refuses every write while a connected
   * system owns the company's tax — which left the ingested rates, the only ones such a company
   * has, unable to be switched off. Availability is a CLARA-side decision about what this company
   * is offered; nothing is written to QuickBooks, and a later sync still sees the rate.
   *
   * Returns the whole settings payload, like the default endpoint, because deactivating can also
   * clear the default and the screen has to reflect both.
   */
  static async setSalesTaxActiveState(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });
    const id = Number(req.params.id);
    if (!Number.isInteger(id))
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "id must be an integer" } });
    // Strict, not truthy: a body of `{ isActive: "false" }` must not switch a rate ON.
    if (typeof req.body?.isActive !== "boolean")
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "isActive must be true or false" } });
    const isActive = req.body.isActive;
    try {
      await setSalesTaxActive(
        companyId,
        id,
        isActive,
        req.user?.userId == null ? null : BigInt(req.user.userId)
      );
      logger.info("Sales tax availability changed", { companyId, id, isActive });
      const { taxSource, taxEnabled, taxEnforced, taxEnforcedBy, rates } = await listSalesTax(companyId);
      res.json({
        success: true,
        data: {
          taxSource,
          taxEnabled,
          taxEnforced,
          taxEnforcedBy,
          rates: rates.map((r) => ({ ...r, ratePercent: Number(r.ratePercent) })),
        },
      });
    } catch (e) {
      const message = clientSafeMessage(e, "Could not change the rate");
      res.status(400).json({ success: false, error: { status: 400, message } });
    }
  }

  /**
   * PUT /api/v1/companies/sales-tax/default — choose the rate new estimates start with.
   * Body: { id } — or { id: null } to have new estimates start untaxed.
   */
  static async setSalesTaxDefault(req: RequestWithUser, res: Response) {
    const companyId = req.user?.companyId;
    if (companyId == null)
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "No company on this account" } });
    const raw = req.body?.id;
    const id = raw == null ? null : Number(raw);
    if (id !== null && !Number.isInteger(id))
      return res
        .status(400)
        .json({ success: false, error: { status: 400, message: "id must be an integer or null" } });
    try {
      await setDefaultSalesTax(companyId, id);
      const { taxSource, taxEnabled, taxEnforced, taxEnforcedBy, rates } = await listSalesTax(companyId);
      res.json({
        success: true,
        data: {
          taxSource,
          taxEnabled,
          taxEnforced,
          taxEnforcedBy,
          rates: rates.map((r) => ({ ...r, ratePercent: Number(r.ratePercent) })),
        },
      });
    } catch (e) {
      const message = clientSafeMessage(e, "Could not set the default");
      res.status(400).json({ success: false, error: { status: 400, message } });
    }
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
