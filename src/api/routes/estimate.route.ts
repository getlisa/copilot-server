import { Router } from "express";
import { EstimateController } from "../controllers/estimate.controller";
import { validate } from "../middlewares/validate";
import { estimateStreamSchema } from "../schemas/estimate.schema";

const estimateRoute = Router();

// Note: No auth middleware yet, for parity with the existing copilot/chat routes.

/**
 * @route   POST /api/v1/copilot/:conversationId/estimate/stream
 * @desc    DEMO-ONLY: run the self-contained estimate-cost engine and stream the
 *          response over SSE (events: user_message, thinking, chunk, quote, done, error)
 * @access  Public (for demo)
 */
estimateRoute.post(
  "/:conversationId/estimate/stream",
  validate(estimateStreamSchema),
  EstimateController.stream
);

/**
 * @route   GET /api/v1/copilot/:conversationId/estimate/:messageId/pdf
 * @desc    Re-presign + 302-redirect to the downloadable quotation PDF for a quote.
 * @access  Public (for demo)
 */
estimateRoute.get(
  "/:conversationId/estimate/:messageId/pdf",
  EstimateController.downloadPdf
);

export { estimateRoute };
