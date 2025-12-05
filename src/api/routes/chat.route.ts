import { Router } from "express";
import { ChatController } from "../controllers/chat.controller";

const chatRoute = Router();

// Note: No auth middleware for easier testing
// In production, add authMiddleware here

/**
 * @route   POST /chat/:conversationId/send
 * @desc    Send a message and get AI response
 * @access  Public (for testing)
 */
chatRoute.post("/:conversationId/send", ChatController.sendMessage);

/**
 * @route   POST /chat/:conversationId/stream
 * @desc    Send a message and stream AI response (SSE)
 * @access  Public (for testing)
 */
chatRoute.post("/:conversationId/stream", ChatController.streamMessage);

export { chatRoute };


