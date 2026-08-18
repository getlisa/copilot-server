import { Router } from "express";
import { imageUpload } from "../middlewares/imageUpload";
import { authMiddleware } from "../middlewares/auth";
import { CompanyController } from "../controllers/company.controller";

/**
 * Company registration. Deliberately unauthenticated: the registration page is
 * hidden (reachable only by direct URL) and exists so a new company can be set
 * up before any of its users have accounts.
 * The settings routes below ARE auth'd — they read/write the caller's own company.
 */
const companyRoute = Router();

companyRoute.post("/", imageUpload.single("logo"), CompanyController.create);
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
