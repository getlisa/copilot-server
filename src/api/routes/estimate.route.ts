import { Router } from "express";
import { EstimateController } from "../controllers/estimate.controller";
import { CopilotController } from "../controllers/copilot.controller";
import { validate } from "../middlewares/validate";
import { estimateStreamSchema, estimateSignSchema, estimateEmailSchema } from "../schemas/estimate.schema";

const estimateRoute = Router();

// Note: No auth middleware yet, for parity with the existing copilot/chat routes.

/**
 * @route   POST /api/v1/copilot/:conversationId/stream
 * @desc    UNIFIED copilot endpoint. Runs the LangGraph orchestrator (router →
 *          general | estimate) and streams named SSE frames (user_message, thinking,
 *          routing, node, chunk, tool_call, citations, sources, followUps, identified,
 *          message, quote, questions, done, error). The router auto-selects the agent;
 *          an optional body `mode` ("estimate"|"general") is treated as a prior.
 * @access  Public (for testing)
 */
estimateRoute.post("/:conversationId/stream", CopilotController.stream);

/**
 * @route   POST /api/v1/copilot/:conversationId/send
 * @desc    Non-streaming variant of the unified copilot endpoint.
 * @access  Public (for testing)
 */
estimateRoute.post("/:conversationId/send", CopilotController.send);

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
 * @route   POST /api/v1/copilot/:conversationId/estimate/:messageId/sign
 * @desc    Confirm an estimate with the customer's digital signature and generate the
 *          final signed quotation PDF (stored in S3). Returns a downloadable URL.
 * @access  Public (for demo)
 */
estimateRoute.post(
  "/:conversationId/estimate/:messageId/sign",
  validate(estimateSignSchema),
  EstimateController.sign
);

/**
 * @route   POST /api/v1/copilot/:conversationId/estimate/:messageId/email
 * @desc    Email the signed quotation PDF to the customer (SendGrid). Body: { to }.
 * @access  Public (for demo)
 */
estimateRoute.post(
  "/:conversationId/estimate/:messageId/email",
  validate(estimateEmailSchema),
  EstimateController.emailEstimate
);

/**
 * @route   GET /api/v1/copilot/:conversationId/estimate/:messageId/preview
 * @desc    Stream an UNSIGNED draft of the quotation PDF (inline) so the customer can
 *          preview the estimate before signing. Generated on the fly; no signature.
 * @access  Public (for demo)
 */
estimateRoute.get(
  "/:conversationId/estimate/:messageId/preview",
  EstimateController.previewPdf
);

/**
 * @route   GET /api/v1/copilot/:conversationId/estimate/:messageId/pdf
 * @desc    Re-presign + 302-redirect to the downloadable signed quotation PDF.
 * @access  Public (for demo)
 */
estimateRoute.get(
  "/:conversationId/estimate/:messageId/pdf",
  EstimateController.downloadPdf
);

export { estimateRoute };
