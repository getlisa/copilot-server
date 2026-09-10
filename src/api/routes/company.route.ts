import { Router } from "express";
import { imageUpload } from "../middlewares/imageUpload";
import { authMiddleware, requireAdmin } from "../middlewares/auth";
import { CompanyController } from "../controllers/company.controller";

/**
 * Company registration. Deliberately unauthenticated: the registration page is
 * hidden (reachable only by direct URL) and exists so a new company can be set
 * up before any of its users have accounts.
 * The settings routes below ARE auth'd — they read/write the caller's own company.
 */
const companyRoute = Router();

companyRoute.post("/", imageUpload.single("logo"), CompanyController.create);

// QuickBooks. Intuit redirects the user's BROWSER to the callback, so it cannot be authenticated;
// its credential is the signed state minted by the (admin-only) connect route. Register it first
// so nothing else can shadow the path.
companyRoute.get("/connections/qbo/callback", CompanyController.qboCallback);

// Status is readable by every user of the company (the card shows everyone whether QuickBooks is
// hooked up); acting on the connection is admin-only. The item list stays open to all roles on
// purpose — the quote screen fetches it for every technician to fill the per-line item dropdown,
// and gating it would silently remove that dropdown with no error anywhere.
companyRoute.get("/connections", authMiddleware, CompanyController.getConnections);
companyRoute.get("/connections/qbo/items", authMiddleware, CompanyController.listQboItems);
companyRoute.post(
  "/connections/qbo/connect",
  authMiddleware,
  requireAdmin,
  CompanyController.startQboConnect
);
companyRoute.delete(
  "/connections/qbo",
  authMiddleware,
  requireAdmin,
  CompanyController.disconnectQboForCompany
);

// ZenTrades. No OAuth — an admin submits the company's ZenTrades login, which is validated by
// an actual login before being stored sealed. Status rides the shared /connections read above.
companyRoute.post(
  "/connections/zt/connect",
  authMiddleware,
  requireAdmin,
  CompanyController.connectZtForCompany
);
companyRoute.post(
  "/connections/zt/sync",
  authMiddleware,
  requireAdmin,
  CompanyController.syncZtForCompany
);
// The job picker read stays open to every role — technicians start estimates from it.
companyRoute.get("/connections/zt/jobs", authMiddleware, CompanyController.listZtJobsForCompany);
companyRoute.get("/connections/zt/sync/progress", authMiddleware, CompanyController.ztSyncProgress);
companyRoute.delete(
  "/connections/zt",
  authMiddleware,
  requireAdmin,
  CompanyController.disconnectZtForCompany
);

// Reference data. The sync is a settings write, so admin-only. The reads a technician's estimate
// screen needs — the customer picker — are open to every role, for the same reason the item list
// is: gating them empties the picker with no error anywhere.
companyRoute.post(
  "/connections/qbo/sync",
  authMiddleware,
  requireAdmin,
  CompanyController.syncQboData
);
companyRoute.get("/qbo/customers", authMiddleware, CompanyController.listQboCustomers);
// Creating a customer is part of the technician's flow on the estimate screen, not a settings
// action — an admin gate here would block posting the estimate until the office logs in.
companyRoute.post(
  "/qbo/customers",
  authMiddleware,
  CompanyController.createQboCustomerForCompany
);
companyRoute.get(
  "/qbo/income-accounts",
  authMiddleware,
  requireAdmin,
  CompanyController.listQboIncomeAccounts
);
// Sales-tax rates are readable by every role: an estimate must show the rate it applies, and
// gating this would blank the totals for technicians.
companyRoute.get("/sales-tax", authMiddleware, CompanyController.listSalesTaxRates);
// Whether tax applies to this company at all. Admin-only: it decides whether customer-facing
// documents carry tax. Refused while QuickBooks or a CRM is connected — either forces it on.
companyRoute.put("/tax-enabled", authMiddleware, requireAdmin, CompanyController.setTaxEnabled);
// Writing a rate is admin-only: it is applied to money on customer-facing estimates.
companyRoute.post("/sales-tax", authMiddleware, requireAdmin, CompanyController.saveSalesTax);
// Availability only, and admin-only like every other tax write. Its own route rather than a
// field on the POST above, because that one refuses all writes while QuickBooks owns the
// company's tax — which is exactly when this has to work.
companyRoute.put(
  "/sales-tax/:id/active",
  authMiddleware,
  requireAdmin,
  CompanyController.setSalesTaxActiveState
);
companyRoute.put(
  "/sales-tax/default",
  authMiddleware,
  requireAdmin,
  CompanyController.setSalesTaxDefault
);

companyRoute.get("/markup", authMiddleware, CompanyController.getDefaultMarkup);
companyRoute.put("/markup", authMiddleware, requireAdmin, CompanyController.putDefaultMarkup);
companyRoute.get(
  "/proposal-email-template",
  authMiddleware,
  CompanyController.getProposalEmailTemplate
);
companyRoute.put(
  "/proposal-email-template",
  authMiddleware,
  CompanyController.updateProposalEmailTemplate
);

export { companyRoute };
