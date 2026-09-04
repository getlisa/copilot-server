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
