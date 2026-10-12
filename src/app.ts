import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import { apiRouter } from "./api/routes.js";
import { config } from "./config/env.js";
import { logger, pinoHttp } from "./config/logger.js";
import { createErrorResponse } from "./modules/output/index.js";
import { publicErrorResponse } from "./modules/api/errors.js";
import { authMiddleware } from "./modules/runtime/auth.js";
import { rateLimitMiddleware } from "./modules/runtime/rateLimit.js";
import { getMetricsSnapshot } from "./modules/runtime/metrics.js";
import { healthCheckDatabase, isDatabaseConfigured } from "./modules/database/index.js";
import { webAuthRouter } from "./modules/webauth/routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "../web");

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  if (config.trustProxy) {
    // Railway / reverse proxies terminate TLS and set X-Forwarded-*.
    app.set("trust proxy", 1);
  }
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  const corsOrigins = config.corsOrigins;
  const corsCredentials = config.crossOriginUi;
  app.use(
    cors({
      origin:
        corsOrigins.length > 0
          ? (origin, cb) => {
              // Allow non-browser clients (no Origin) and configured frontend origins.
              if (!origin || corsOrigins.includes(origin)) cb(null, true);
              else cb(new Error("CORS origin denied"));
            }
          : config.nodeEnv === "production"
            ? false
            : true,
      credentials: corsCredentials,
    }),
  );

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) =>
          req.url === "/health" ||
          req.url === "/ready" ||
          req.url === "/api/health" ||
          req.url === "/api/ready" ||
          req.url === "/api/v1/health",
      },
    }),
  );

  // Liveness — process is up (no dependency checks)
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", service: "bs-app" });
  });

  // Readiness — required dependencies
  app.get("/ready", async (_req, res) => {
    if (!isDatabaseConfigured()) {
      res.status(200).json({
        status: "ready",
        database: { configured: false, ok: true, message: "optional" },
      });
      return;
    }
    const db = await healthCheckDatabase({ failIfUnreachable: true });
    if (!db.ok) {
      res.status(503).json({ status: "not_ready", database: db });
      return;
    }
    res.status(200).json({ status: "ready", database: db });
  });

  app.get("/api", (_req, res) => {
    res.json({
      service: "Bank Statement Extraction Service",
      status: "ready",
      app: "/",
      endpoints: {
        health: "GET /health",
        ready: "GET /ready",
        login: "POST /api/v1/auth/login",
        extract: "POST /api/v1/statements/extract",
        extractUrl: "POST /api/v1/statements/extract-url",
        openapi: "GET /api/docs/openapi.json",
      },
      auth: config.requireAuth ? "api_key_or_web_session" : "optional",
    });
  });

  app.use(authMiddleware);
  app.use(rateLimitMiddleware({ name: "global" }));

  app.use("/api/v1/auth", webAuthRouter);

  app.get("/api/metrics", (_req, res) => {
    res.status(200).json(getMetricsSnapshot());
  });

  app.use("/api", apiRouter);

  if (config.serveWeb) {
    // Analysis web app (login + dashboard + report) — optional when UI is separate.
    app.use(express.static(webRoot, { index: "index.html", extensions: ["html"] }));
    app.get(["/app", "/app/*", "/dashboard", "/report"], (_req, res) => {
      res.sendFile(path.join(webRoot, "index.html"));
    });

    app.use((req, res) => {
      if (req.path.startsWith("/api")) {
        res.status(404).json(createErrorResponse("NOT_FOUND", "Route not found"));
        return;
      }
      res.sendFile(path.join(webRoot, "index.html"));
    });
  } else {
    app.use((req, res) => {
      if (req.path.startsWith("/api") || req.path === "/health" || req.path === "/ready") {
        res.status(404).json(createErrorResponse("NOT_FOUND", "Route not found"));
        return;
      }
      res.status(404).json({
        success: false,
        error: {
          code: "NOT_FOUND",
          message: "API-only mode (SERVE_WEB=false). Host the frontend separately.",
        },
      });
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "unhandled error");

    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "LIMIT_FILE_SIZE"
    ) {
      res
        .status(413)
        .json(publicErrorResponse("FILE_TOO_LARGE", "Uploaded file exceeds size limit"));
      return;
    }

    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "LIMIT_UNEXPECTED_FILE"
    ) {
      res
        .status(400)
        .json(publicErrorResponse("INVALID_INPUT", "Malformed multipart request"));
      return;
    }

    if (err instanceof Error && /CORS origin denied/i.test(err.message)) {
      res.status(403).json(publicErrorResponse("FORBIDDEN", "Origin not allowed"));
      return;
    }

    res
      .status(500)
      .json(publicErrorResponse("INTERNAL_ERROR", "Unexpected server error"));
  });

  return app;
}
