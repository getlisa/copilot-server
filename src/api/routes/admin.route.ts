import { Router } from "express";
import multer from "multer";
import { adminAuth } from "../middlewares/adminAuth";
import { imageUpload } from "../middlewares/imageUpload";
import { AdminController } from "../controllers/admin.controller";

/**
 * Internal Clara-team configuration API — the PRDs' backend mechanism. Everything here
 * requires the X-Admin-Token header (see adminAuth); nothing is reachable with a
 * technician JWT.
 */
const adminRoute = Router();
adminRoute.use(adminAuth);

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
adminRoute.post("/companies/:companyId/templates", AdminController.createTemplate);

adminRoute.get("/companies/:companyId/conversations", AdminController.listConversations);
adminRoute.delete("/companies/:companyId/conversations", AdminController.deleteConversations);

export { adminRoute };
