import { Router } from "express";
import multer from "multer";
import { imageUpload } from "../middlewares/imageUpload";
import { AdminController } from "../controllers/admin.controller";

/**
 * Internal Clara-team configuration API — the PRDs' backend mechanism. Mounted under a
 * non-obvious path (see server.ts) and deliberately unauthenticated, the same hidden-URL
 * pattern as company registration. Never link to it from any user-facing surface.
 */
const adminRoute = Router();

// Pricebook files: parsed in memory, validated by format inside ingest.ts.
const pricebookUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

adminRoute.get("/companies", AdminController.listCompanies);
adminRoute.get("/companies/:companyId", AdminController.getCompany);
adminRoute.patch("/companies/:companyId/config", AdminController.patchConfig);
adminRoute.post("/companies/:companyId/logo", imageUpload.single("logo"), AdminController.uploadLogo);

adminRoute.get("/companies/:companyId/pricebooks", AdminController.listPricebooks);
adminRoute.post(
  "/companies/:companyId/pricebooks",
  pricebookUpload.single("file"),
  AdminController.createPricebook
);
adminRoute.patch("/companies/:companyId/pricebooks/priorities", AdminController.reorderPricebooks);
adminRoute.put(
  "/pricebooks/:pricebookId/file",
  pricebookUpload.single("file"),
  AdminController.replacePricebookFile
);
adminRoute.delete("/pricebooks/:pricebookId", AdminController.deletePricebook);

adminRoute.get("/companies/:companyId/labor-rates", AdminController.listLaborRates);
adminRoute.post("/companies/:companyId/labor-rates", AdminController.createLaborRate);
adminRoute.patch("/labor-rates/:id", AdminController.updateLaborRate);
adminRoute.delete("/labor-rates/:id", AdminController.deleteLaborRate);

adminRoute.get("/companies/:companyId/templates", AdminController.listTemplates);
adminRoute.post(
  "/companies/:companyId/templates",
  pricebookUpload.single("file"), // .docx template file; validated in the controller
  AdminController.createTemplate
);
adminRoute.delete("/templates/:id", AdminController.deleteTemplate);

adminRoute.get("/companies/:companyId/proposal-template", AdminController.getProposalTemplate);
adminRoute.put("/companies/:companyId/proposal-template", AdminController.putProposalTemplate);
adminRoute.delete("/companies/:companyId/proposal-template", AdminController.deleteProposalTemplate);
adminRoute.post(
  "/companies/:companyId/proposal-template/import",
  pricebookUpload.single("file"), // .docx or .pdf; validated inside the importer
  AdminController.importProposalTemplate
);
adminRoute.post(
  "/companies/:companyId/proposal-template/preview",
  AdminController.previewProposalTemplate
);

adminRoute.get("/companies/:companyId/conversations", AdminController.listConversations);
adminRoute.delete("/companies/:companyId/conversations", AdminController.deleteConversations);

export { adminRoute };
