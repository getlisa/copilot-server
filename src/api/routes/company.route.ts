import { Router } from "express";
import { imageUpload } from "../middlewares/imageUpload";
import { CompanyController } from "../controllers/company.controller";

/**
 * Company registration. Deliberately unauthenticated: the registration page is
 * hidden (reachable only by direct URL) and exists so a new company can be set
 * up before any of its users have accounts.
 */
const companyRoute = Router();

companyRoute.post("/", imageUpload.single("logo"), CompanyController.create);

export { companyRoute };
