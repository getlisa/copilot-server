import express from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import { conversationRoute } from "./api/routes/conversation.route";
import { chatRoute } from "./api/routes/chat.route";
import { voiceRoute } from "./api/routes/voice.route";
import logger from "./lib/logger";

dotenv.config();
const app = express();

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "../public")));

app.use(
  cors({
    origin: process.env.ALLOW_ORIGIN,
    credentials: true,
    allowedHeaders: "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Dev-Bypass, X-User-Id, X-User-Email, X-User-Role, X-Company-Id",
    preflightContinue: false,
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
  })
);
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();

  logger.request(req.method, req.url, {
    query: Object.keys(req.query).length > 0 ? req.query : undefined,
    bodyKeys: req.body ? Object.keys(req.body) : undefined,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  });

  // Log response when finished
  res.on("finish", () => {
    logger.response(req.method, req.url, res.statusCode, Date.now() - startTime);
  });

  next();
});

// Routes
app.use("/api/v1/conversations", conversationRoute);
app.use("/api/v1/chat", chatRoute);
app.use("/api/voice", voiceRoute);

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// OpenAI Realtime token endpoint (for voice)
app.post("/realtime-token", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "OpenAI API key not configured" });
    }

    // Request ephemeral token from OpenAI
    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-realtime-preview-2024-12-17",
        voice: "marin",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error("Failed to get realtime token", { error });
      return res.status(response.status).json({ error: "Failed to get voice token" });
    }

    const data = await response.json();
    res.json({ token: data.client_secret?.value });
  } catch (error) {
    logger.error("Realtime token error", { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: "Failed to get voice token" });
  }
});

// 404 handler
app.use((req, res) => {
  logger.warn("Route not found", { method: req.method, path: req.path });
  res.status(404).json({
    success: false,
    error: {
      status: 404,
      message: `Route ${req.method} ${req.path} not found`,
    },
  });
});

// Global error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error("Unhandled error", {
    method: req.method,
    path: req.path,
    error: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    success: false,
    error: {
      status: 500,
      message: "Internal server error",
    },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server started`, {
    port: PORT,
    environment: process.env.NODE_ENV || "development",
  });
});
