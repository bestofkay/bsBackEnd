import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const boolFromEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.string().optional().default(""),

  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(26_214_400),
  MAX_DOWNLOAD_BYTES: z.coerce.number().int().positive().optional(),
  MAX_PDF_PAGES: z.coerce.number().int().positive().default(200),
  MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(40_000_000),
  MAX_SPREADSHEET_BYTES: z.coerce.number().int().positive().optional(),
  MAX_PROCESSING_TIME_MS: z.coerce.number().int().positive().default(180_000),
  OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  MAX_CONCURRENT_DOCUMENTS: z.coerce.number().int().positive().default(2),

  UPLOAD_DIR: z.string().default("./uploads"),
  DOCUMENT_RETENTION_HOURS: z.coerce.number().nonnegative().default(0),
  RETAIN_TEMP_FILES: boolFromEnv,

  ALLOWED_URL_HOSTS: z.string().optional().default(""),
  URL_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  URL_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  URL_MAX_REDIRECTS: z.coerce.number().int().nonnegative().default(3),
  ALLOW_LOOPBACK_FOR_TESTS: boolFromEnv,

  /** Comma-separated API keys. Empty = auth disabled (forbidden in production). */
  API_KEYS: z.string().optional().default(""),
  /** Require API key even in development when true. */
  REQUIRE_AUTH: boolFromEnv,

  /** Comma-separated CORS origins. Empty = reflect request origin only in non-prod; prod requires explicit list. */
  CORS_ORIGINS: z.string().optional().default(""),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_EXTRACT_MAX: z.coerce.number().int().positive().default(10),

  /** Trust X-Forwarded-* from Railway / reverse proxies. */
  TRUST_PROXY: boolFromEnv,

  /**
   * Serve the static web desk from Express.
   * Set false when the UI is hosted on a separate frontend server.
   */
  SERVE_WEB: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  /**
   * Cookie SameSite policy.
   * Use "none" when frontend and API are on different sites (requires HTTPS + Secure).
   * Default: "none" when CORS_ORIGINS is set, otherwise "lax".
   */
  COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).optional(),
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  databaseUrl: string | null;
  maxUploadBytes: number;
  maxDownloadBytes: number;
  maxPdfPages: number;
  maxImagePixels: number;
  maxSpreadsheetBytes: number;
  maxProcessingTimeMs: number;
  ocrTimeoutMs: number;
  maxConcurrentDocuments: number;
  uploadDir: string;
  documentRetentionHours: number;
  retainTempFiles: boolean;
  allowedUrlHosts: string[];
  urlConnectTimeoutMs: number;
  urlDownloadTimeoutMs: number;
  urlMaxRedirects: number;
  allowLoopbackForTests: boolean;
  apiKeys: string[];
  requireAuth: boolean;
  corsOrigins: string[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
  rateLimitExtractMax: number;
  trustProxy: boolean;
  serveWeb: boolean;
  cookieSameSite: "lax" | "strict" | "none";
  /** True when API expects a browser UI on another origin. */
  crossOriginUi: boolean;
};

function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

/** Build mysql:// URL from Railway MySQL plugin vars when DATABASE_URL is absent. */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const direct = (env.DATABASE_URL || env.MYSQL_URL || env.MYSQLDATABASE_URL || "").trim();
  if (direct) {
    // Prisma expects mysql:// — normalize mysql2:// if a plugin emits it.
    return direct.replace(/^mysql2:\/\//i, "mysql://");
  }
  const host = env.MYSQLHOST || env.MYSQL_HOST;
  const user = env.MYSQLUSER || env.MYSQL_USER;
  const password = env.MYSQLPASSWORD || env.MYSQL_PASSWORD || "";
  const database = env.MYSQLDATABASE || env.MYSQL_DATABASE;
  const port = env.MYSQLPORT || env.MYSQL_PORT || "3306";
  if (host && user && database) {
    const auth = password
      ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
      : encodeURIComponent(user);
    return `mysql://${auth}@${host}:${port}/${database}`;
  }
  return "";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const withDb = {
    ...env,
    DATABASE_URL: resolveDatabaseUrl(env),
  };
  const parsed = envSchema.safeParse(withDb);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }

  const data = parsed.data;
  const maxUploadBytes = data.MAX_UPLOAD_BYTES;
  const apiKeys = parseList(data.API_KEYS);
  const nodeEnv = data.NODE_ENV;
  const requireAuth = data.REQUIRE_AUTH || (nodeEnv === "production" && apiKeys.length > 0);

  if (nodeEnv === "production" && apiKeys.length === 0) {
    // Fail-fast: production must configure authentication boundary.
    throw new Error(
      "Invalid configuration: API_KEYS is required when NODE_ENV=production",
    );
  }

  return {
    nodeEnv,
    port: data.PORT,
    logLevel: data.LOG_LEVEL,
    databaseUrl: data.DATABASE_URL.trim() || null,
    maxUploadBytes,
    maxDownloadBytes: data.MAX_DOWNLOAD_BYTES ?? maxUploadBytes,
    maxPdfPages: data.MAX_PDF_PAGES,
    maxImagePixels: data.MAX_IMAGE_PIXELS,
    maxSpreadsheetBytes: data.MAX_SPREADSHEET_BYTES ?? maxUploadBytes,
    maxProcessingTimeMs: data.MAX_PROCESSING_TIME_MS,
    ocrTimeoutMs: data.OCR_TIMEOUT_MS,
    maxConcurrentDocuments: data.MAX_CONCURRENT_DOCUMENTS,
    uploadDir: data.UPLOAD_DIR,
    documentRetentionHours: data.DOCUMENT_RETENTION_HOURS,
    retainTempFiles: data.RETAIN_TEMP_FILES,
    allowedUrlHosts: parseList(data.ALLOWED_URL_HOSTS).map((h) => h.toLowerCase()),
    urlConnectTimeoutMs: data.URL_CONNECT_TIMEOUT_MS,
    urlDownloadTimeoutMs: data.URL_DOWNLOAD_TIMEOUT_MS,
    urlMaxRedirects: data.URL_MAX_REDIRECTS,
    allowLoopbackForTests: nodeEnv === "test" && data.ALLOW_LOOPBACK_FOR_TESTS,
    apiKeys,
    requireAuth: requireAuth || apiKeys.length > 0,
    corsOrigins: parseList(data.CORS_ORIGINS),
    rateLimitWindowMs: data.RATE_LIMIT_WINDOW_MS,
    rateLimitMax: nodeEnv === "test" ? Math.max(data.RATE_LIMIT_MAX, 1000) : data.RATE_LIMIT_MAX,
    rateLimitExtractMax:
      nodeEnv === "test" ? Math.max(data.RATE_LIMIT_EXTRACT_MAX, 1000) : data.RATE_LIMIT_EXTRACT_MAX,
    // Railway / most PaaS set this; default on in production so secure cookies + client IP work.
    trustProxy:
      data.TRUST_PROXY ||
      nodeEnv === "production" ||
      Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID),
    serveWeb: data.SERVE_WEB ?? true,
    cookieSameSite:
      data.COOKIE_SAMESITE ??
      (parseList(data.CORS_ORIGINS).length > 0 ? "none" : "lax"),
    crossOriginUi: parseList(data.CORS_ORIGINS).length > 0,
  };
}

export const config = loadConfig();
