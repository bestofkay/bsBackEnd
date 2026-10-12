/**
 * Authentication boundary.
 * Accepts API keys (X-API-Key / Bearer) and/or web session cookies.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "../../config/env.js";
import { publicErrorResponse } from "../api/errors.js";
import {
  SESSION_COOKIE,
  getSession,
  parseCookie,
} from "../webauth/sessions.js";

export type AuthContext = {
  authenticated: boolean;
  apiKeyHash: string | null;
  webUserId?: string | null;
  webEmail?: string | null;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function extractApiKey(req: Request): string | null {
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }
  return null;
}

function keyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isAuthRequired(): boolean {
  return config.requireAuth && config.apiKeys.length > 0;
}

function attachWebSession(req: Request): boolean {
  const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
  const session = getSession(token);
  if (!session) return false;
  req.auth = {
    authenticated: true,
    apiKeyHash: null,
    webUserId: session.userId,
    webEmail: session.email,
  };
  return true;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const path = req.path || "";
  const isPublicAuth =
    path.startsWith("/api/v1/auth/login") ||
    path.startsWith("/api/v1/auth/logout") ||
    path.startsWith("/api/v1/auth/me") ||
    path === "/api/v1/auth/login" ||
    path === "/api/v1/auth/logout" ||
    path === "/api/v1/auth/me";

  // Web UI session always counted as authenticated for API access.
  if (attachWebSession(req)) {
    next();
    return;
  }

  if (isPublicAuth || !isAuthRequired()) {
    req.auth = { authenticated: false, apiKeyHash: null };
    next();
    return;
  }

  const provided = extractApiKey(req);
  if (!provided) {
    res
      .status(401)
      .json(publicErrorResponse("UNAUTHORIZED", "API key or login session required"));
    return;
  }

  const matched = config.apiKeys.some((k) => keyMatches(provided, k));
  if (!matched) {
    res
      .status(401)
      .json(publicErrorResponse("UNAUTHORIZED", "Invalid API key"));
    return;
  }

  req.auth = {
    authenticated: true,
    apiKeyHash: hashApiKey(provided),
  };
  next();
}

/** Require an active web session (for UI-only routes if needed). */
export function requireWebSession(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.webUserId) {
    next();
    return;
  }
  if (attachWebSession(req)) {
    next();
    return;
  }
  res.status(401).json(publicErrorResponse("UNAUTHORIZED", "Please sign in"));
}
