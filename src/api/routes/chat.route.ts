import { Router } from "express";
import { CopilotController } from "../controllers/copilot.controller";

const chatRoute = Router();

// Note: No auth middleware for easier testing
// In production, add authMiddleware here
//
// Back-compat: the legacy /chat endpoints now delegate to the unified copilot
// orchestrator (router → general | estimate). They emit NAMED SSE frames like the
// unified /api/v1/copilot/:id/stream endpoint. New clients should prefer that route.

/**
 * @route   POST /chat/:conversationId/send
 * @desc    Send a message and get AI response (non-streaming) via the orchestrator
 * @access  Public (for testing)
 */
chatRoute.post("/:conversationId/send", CopilotController.send);

/**
 * @route   POST /chat/:conversationId/stream
 * @desc    Send a message and stream the AI response (SSE) via the orchestrator
 * @access  Public (for testing)
 */
chatRoute.post("/:conversationId/stream", CopilotController.stream);

export { chatRoute };


