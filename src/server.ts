import express from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import { conversationRoute } from "./api/routes/conversation.route";
import { chatRoute } from "./api/routes/chat.route";
import { voiceRoute } from "./api/routes/voice.route";
import { estimateRoute } from "./api/routes/estimate.route";
import { quoteRoute } from "./api/routes/quote.route";
import { companyRoute } from "./api/routes/company.route";
import { adminRoute } from "./api/routes/admin.route";
import logger from "./lib/logger";

dotenv.config();

// Enable BigInt JSON serialization (converts to string)
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

const app = express();

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "../public")));

app.use(
  cors({
    origin: process.env.ALLOW_ORIGIN,
    credentials: true,
    allowedHeaders: "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Dev-Bypass, X-User-Id, X-User-Email, X-User-Role, X-Company-Id, X-Device-Timezone, X-Admin-Token",
    preflightContinue: false,
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
  })
);
// Parse JSON bodies. Some native clients (ClaraWearables, AskAI) POST JSON without a
// proper `Content-Type: application/json` header, which would otherwise leave req.body
// undefined and surface as confusing "body Required" / destructure errors. So we also
// parse when the content-type is missing, text/plain, or octet-stream — but NOT for
// multipart/form-data (image uploads via multer) or urlencoded forms.
app.use(
  express.json({
    limit: "50mb",
    type: (req) => {
      const ct = (req.headers["content-type"] || "").toLowerCase();
      if (!ct) return true; // no header → assume JSON
      if (ct.includes("multipart/form-data")) return false;
      if (ct.includes("application/x-www-form-urlencoded")) return false;
      return /application\/json|\+json|text\/plain|application\/octet-stream/.test(ct);
    },
  })
);
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();

  logger.request(req.method, req.url, {
    query: Object.keys(req.query).length > 0 ? req.query : undefined,
    bodyKeys: req.body ? Object.keys(req.body) : undefined,
    bodyParsed: req.body !== undefined,
    contentType: req.headers["content-type"] ?? "(none)",
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
app.use("/api/v1/voice", voiceRoute);
app.use("/api/v1/copilot", estimateRoute); // DEMO-ONLY estimate-cost mode
app.use("/api/v1/quotes", quoteRoute); // Estimating Agent (chat-as-quote, Draft → Completed)
app.use("/api/v1/companies", companyRoute); // Hidden company registration (URL-only access)
app.use("/api/v1/admin", adminRoute); // Internal Clara-team config (X-Admin-Token required)

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
