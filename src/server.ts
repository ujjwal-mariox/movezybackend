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

(async () => {
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
  });
})();

// Graceful shutdown
gracefulShutdown(httpServer);
