import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import { createServer } from "http";
import swaggerUi from "swagger-ui-express";

import routes from "./routes";
import connectDB from "./models";
import config from "./config";
import swaggerSpec from "./config/swagger";
import { initRedis, cache } from "./utils/redis.util";
import { initSocket } from "./utils/socket.util";
import { initMqtt, closeMqtt } from "./utils/mqtt.util";
import { initializeRazorpay } from "./services/payment.service";
import { initializeFirebase } from "./services/notification.service";
import { startDelayDetection } from "./services/delay-detection.service";
import { startAutomationEngine } from "./services/automation-engine.service";
import { startReportScheduler } from "./services/scheduled-report.service";
import { startOnboardingReminders } from "./services/onboarding-reminder.service";
import { startScheduledDispatch } from "./services/scheduled-dispatch.service";
import { rateLimiters } from "./middlewares/rate-limit.middleware";
import {
  requestTimeout,
  requestId,
  securityHeaders,
  healthCheck,
  gracefulShutdown,
  requestLogger,
} from "./middlewares/server.middleware";

const app = express();
const httpServer = createServer(app);

/**
 * Connect MongoDB and Redis
 */
const initializeConnections = async () => {
  try {
    // Connect MongoDB
    await connectDB();
    console.log("MongoDB connected");

    // Initialize Redis
    await initRedis();
    console.log("Redis connected");

    // Clear stale config caches on startup
    await cache.del("addons:active");
    await cache.del("goodsTypes:active");
    console.log("Config caches cleared on startup");

    // Initialize Socket.io
    await initSocket(httpServer);
    console.log("Socket.io initialized");

    // Initialize MQTT (optional - for driver notifications)
    // TODO: Enable MQTT when broker is configured
    // try {
    //   await initMqtt();
    //   console.log("MQTT initialized");
    // } catch (mqttError) {
    //   console.warn(
    //     "MQTT initialization failed, continuing without MQTT:",
    //     mqttError,
    //   );
    // }
  } catch (error) {
    console.error("Failed to initialize connections:", error);
    process.exit(1);
  }
};

// Server startup deferred until connections are ready (see bottom of file)

/**
 * Security & Performance Middleware
 */
app.use(compression()); // Compress responses
app.use(helmet()); // Security headers (HSTS, CSP, etc.)
app.use(requestId()); // Add request ID for tracing
app.use(requestTimeout(30000)); // 30 second timeout
app.use(securityHeaders()); // Security headers
app.use(requestLogger()); // Request logging

/**
 * Body parser
 */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// TEMP DIAGNOSTIC (remove after debugging logout→login routing): append every
// driver login/onboarding request + response code to _login_diag.log so we can
// see exactly what the phone sends and receives.
app.use((req, res, next) => {
  if (/\/driver\/(login|verify-otp|onboarding-status)/.test(req.path)) {
    const started = Date.now();
    res.on("finish", () => {
      try {
        const fs = require("fs");
        const path = require("path");
        fs.appendFileSync(
          path.join(__dirname, "..", "_login_diag.log"),
          `${new Date().toISOString()} ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - started}ms) auth=${req.headers.authorization ? "yes" : "no"}\n`,
        );
      } catch {}
    });
  }
  next();
});

/**
 * Behind a reverse proxy (nginx on EC2, or an ALB), every request otherwise
 * appears to come from 127.0.0.1 — so the IP-keyed rate limiters below would
 * throttle ALL traffic as a single bucket and one person spamming OTP could
 * lock out every user. `1` = trust exactly one proxy hop; raise it only if you
 * add another layer (e.g. CloudFront in front of the ALB).
 */
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS) || 1);

/**
 * CORS
 */
app.use(
  cors({
    origin: config.cors?.origin || "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-user-data",
      "x-request-id",
    ],
    credentials: true,
  }),
);

/**
 * Rate limiting for general API
 */
app.use("/v1/api", rateLimiters.general);

/**
 * Swagger API Documentation
 */
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    explorer: true,
    customSiteTitle: "Movezy API Documentation",
    customCss: `
      .swagger-ui .topbar { display: none }
      .swagger-ui .info .title { color: #3b82f6 }
    `,
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: "none",
      filter: true,
      showRequestDuration: true,
    },
  }),
);

// Swagger JSON endpoint
app.get("/api-docs.json", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/json");
  res.send(swaggerSpec);
});

/**
 * Routes
 */
app.use("/v1/api", routes);

/**
 * Health check endpoints
 */
app.get("/", (_req: Request, res: Response) => {
  res.send("Hello from Movezy backend!");
});

app.get("/health", healthCheck);

/**
 * 404 handler
 */
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

/**
 * Global error handler
 */
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Error:", err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error",
    ...(config.env === "development" && { stack: err.stack }),
  });
});

/**
 * Start server
 */
const PORT = config.server.port;

/**
 * Production preflight.
 *
 * These are configuration mistakes that are silent at boot but expensive in
 * production, so fail loudly here rather than discovering them from a customer.
 */
const preflight = () => {
  if (config.env !== "production") return;

  const fatal: string[] = [];
  const warn: string[] = [];

  // A wildcard CORS origin with `credentials: true` lets any site call the API
  // with a user's bearer token.
  if (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === "*") {
    fatal.push("CORS_ORIGIN is unset or '*' — set it to your admin origin.");
  }

  // Fare distance depends on this. The public demo is fair-use only and will
  // rate-limit production traffic, silently degrading quotes to straight-line.
  if (!process.env.OSRM_URL) {
    warn.push(
      "OSRM_URL unset — using the public demo router (rate-limited). Self-host before real traffic.",
    );
  }

  // payment.service.ts accepts the legacy RAZORPAY_WEBHOOK_SECRET name too, so
  // check both — otherwise this warns on a perfectly working configuration.
  const webhookSecret =
    process.env.PAYMENT_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!process.env.RAZORPAY_KEY_ID || !webhookSecret) {
    warn.push("Razorpay key or webhook secret missing — payments will fail.");
  }
  if (!process.env.FIREBASE_PROJECT_ID) {
    warn.push("Firebase unset — push notifications are skipped silently.");
  }

  warn.forEach((w) => console.warn(`⚠️  ${w}`));
  if (fatal.length) {
    fatal.forEach((f) => console.error(`❌ ${f}`));
    throw new Error("Refusing to start with unsafe production config.");
  }
};

(async () => {
  preflight();
  await initializeConnections();
  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${config.env || "development"}`);
    initializeRazorpay();
    initializeFirebase();
    startDelayDetection();
    startOnboardingReminders();
    startAutomationEngine();
    startReportScheduler();
    startScheduledDispatch();
  });
})();

// Graceful shutdown
gracefulShutdown(httpServer);
