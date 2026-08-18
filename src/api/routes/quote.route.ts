import { Router } from "express";
import { authMiddleware } from "../middlewares/auth";
import { QuoteController } from "../controllers/quote.controller";

/**
 * Estimating Agent — chat-as-quote lifecycle (Draft → Completed).
 * All routes require auth and are scoped to the requesting technician;
 * a technician only ever sees their own quotes (PRD US1).
 */
const quoteRoute = Router();
quoteRoute.use(authMiddleware);

quoteRoute.post("/", QuoteController.create);
quoteRoute.get("/", QuoteController.list);
quoteRoute.get("/:quoteId", QuoteController.get);
quoteRoute.post("/:quoteId/messages", QuoteController.sendMessage);
quoteRoute.post("/:quoteId/items", QuoteController.addItem);
quoteRoute.patch("/:quoteId/items/:itemId", QuoteController.updateItem);
quoteRoute.delete("/:quoteId/items/:itemId", QuoteController.removeItem);
quoteRoute.post("/:quoteId/items/:itemId/price", QuoteController.priceItem);
quoteRoute.post("/:quoteId/complete", QuoteController.complete);
quoteRoute.post("/:quoteId/reopen", QuoteController.reopen);
quoteRoute.get("/:quoteId/docx", QuoteController.downloadDocx);
quoteRoute.get("/:quoteId/proposal-docx", QuoteController.downloadProposalDocx);
quoteRoute.get("/:quoteId/proposal-pdf", QuoteController.downloadProposalPdf);
quoteRoute.get("/:quoteId/email-draft", QuoteController.emailDraft);
quoteRoute.post("/:quoteId/email", QuoteController.emailProposal);

export { quoteRoute };
