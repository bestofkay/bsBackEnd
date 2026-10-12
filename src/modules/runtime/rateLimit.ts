/**
 * Simple sliding-window rate limiter (per-key, in-memory).
 */

import type { Request, Response, NextFunction } from "express";
import { config } from "../../config/env.js";
import { publicErrorResponse } from "../api/errors.js";
import { incMetric } from "./metrics.js";

type Bucket = { timestamps: number[] };

const buckets = new Map<string, Bucket>();

function clientKey(req: Request): string {
  const auth = req.headers.authorization ?? req.headers["x-api-key"];
  if (typeof auth === "string" && auth.length > 0) {
    return `auth:${auth.slice(0, 24)}`;
  }
  return `ip:${req.ip || req.socket.remoteAddress || "unknown"}`;
}

function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(key, bucket);
  }
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
  if (bucket.timestamps.length >= max) return false;
  bucket.timestamps.push(now);
  return true;
}

export function rateLimitMiddleware(options?: {
  max?: number;
  windowMs?: number;
  name?: string;
}) {
  const max = options?.max ?? config.rateLimitMax;
  const windowMs = options?.windowMs ?? config.rateLimitWindowMs;
  const name = options?.name ?? "general";

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${name}:${clientKey(req)}`;
    if (!allow(key, max, windowMs)) {
      incMetric("rate_limit_exceeded");
      res
        .status(429)
        .json(
          publicErrorResponse(
            "RATE_LIMIT_EXCEEDED",
            "Too many requests. Please retry later.",
          ),
        );
      return;
    }
    next();
  };
}

/** Test helper */
export function resetRateLimits(): void {
  buckets.clear();
}
