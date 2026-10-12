import { describe, expect, it, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { rateLimitMiddleware, resetRateLimits } from "../src/modules/runtime/rateLimit.js";
import { publicErrorResponse } from "../src/modules/api/errors.js";

describe("Group 8 rate limiter unit", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("returns 429 after exceeding max in window", async () => {
    const app = express();
    app.use(rateLimitMiddleware({ name: "unit", max: 2, windowMs: 60_000 }));
    app.get("/x", (_req, res) => res.status(200).json({ ok: true }));
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json(publicErrorResponse("INTERNAL_ERROR", String(err)));
    });

    expect((await request(app).get("/x")).status).toBe(200);
    expect((await request(app).get("/x")).status).toBe(200);
    const limited = await request(app).get("/x");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });
});
