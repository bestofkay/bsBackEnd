/**
 * Group 7 — security, SSRF, sanitization, and hostile input as DATA.
 */

import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  assertHttpUrl,
  isBlockedIpAddress,
  sanitizeUrlForLogs,
  validateUrlForFetch,
} from "../src/modules/security/urlSafety.js";
import { detectFileType } from "../src/modules/security/fileType.js";
import { HTML_BYTES, PDF_BYTES } from "./fileType.test.js";
import { buildCanonicalTransaction } from "../src/modules/transactions/index.js";
import { toPublicExtractionResponse } from "../src/modules/api/publicResponse.js";
import { buildSuccessResponse } from "../src/modules/output/index.js";
import { validateTransactions } from "../src/modules/validation/index.js";
import { buildQualitySummary } from "../src/modules/confidence/index.js";
import { StatementSchema } from "../src/contracts/index.js";
import { maskAccountNumber } from "../src/modules/api/sanitize.js";

describe("Group 7 URL / SSRF security", () => {
  it("blocks unsupported schemes, credentials, metadata, private IPs", () => {
    expect(assertHttpUrl("file:///etc/passwd").ok).toBe(false);
    expect(assertHttpUrl("ftp://example.com/a.pdf").ok).toBe(false);
    expect(assertHttpUrl("https://user:pass@example.com/a.pdf").ok).toBe(false);
    expect(assertHttpUrl("http://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(assertHttpUrl("http://127.0.0.1/x").ok).toBe(false);
    expect(assertHttpUrl("http://10.0.0.5/x").ok).toBe(false);
    expect(assertHttpUrl("http://192.168.1.1/x").ok).toBe(false);
    expect(isBlockedIpAddress("172.16.0.1")).toBe(true);
    expect(isBlockedIpAddress("8.8.8.8")).toBe(false);
  });

  it("enforces host allowlist when configured", async () => {
    const denied = await validateUrlForFetch("https://evil.example/statement.pdf", [
      "trusted.example",
    ]);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.error.code).toBe("URL_HOST_NOT_ALLOWED");
    }
  });

  it("strips credentials from logged URLs", () => {
    expect(sanitizeUrlForLogs("https://alice:secret@example.com/path?token=1")).toBe(
      "https://example.com/path",
    );
  });

  it("API rejects SSRF and malformed URLs with non-200 statuses", async () => {
    const app = createApp();
    const cases = [
      "http://127.0.0.1/statement.pdf",
      "http://169.254.169.254/latest/meta-data",
      "file:///tmp/a.pdf",
      "not-a-url",
    ];
    for (const url of cases) {
      const res = await request(app)
        .post("/api/v1/statements/extract-url")
        .send({ source_type: "url", url });
      expect(res.body.success).toBe(false);
      expect(res.status).not.toBe(200);
    }
  });
});

describe("Group 7 file / upload security", () => {
  it("sniffs magic bytes; ignores HTML disguised as PDF", () => {
    expect(detectFileType(HTML_BYTES)).toBeNull();
    expect(detectFileType(PDF_BYTES)?.extension).toBe("pdf");
  });

  it("rejects path-traversal-like / executable uploads via API", async () => {
    const app = createApp();
    const exe = Buffer.from("MZ\x90\x00fake-pe-header-not-a-pdf");
    const res = await request(app)
      .post("/api/v1/statements/extract")
      .attach("file", exe, "../../../evil.exe");
    expect(res.body.success).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);

    const oversized = await request(app)
      .post("/api/v1/statements/extract")
      .attach("file", Buffer.alloc(0), "empty.csv");
    expect(oversized.status).toBe(400);
  });

  it("treats SQL/XSS payloads in descriptions as inert DATA", () => {
    const hostile = buildCanonicalTransaction({
      transaction_date: "2026-09-01",
      description: "<script>alert(1)</script>; DROP TABLE transactions;--",
      debit: 10,
      amount: -10,
      currency: "NGN",
      transaction_type: "OTHER",
    });
    expect(hostile.description).toContain("<script>");
    expect(hostile.amount).toBe(-10);

    const validation = validateTransactions([hostile]);
    const quality = buildQualitySummary({
      transactions: [hostile],
      validation,
      duplicateCount: 0,
    });
    const internal = buildSuccessResponse({
      statement: StatementSchema.parse({
        currency: "NGN",
        account: { account_number: "0123456789" },
      }),
      transactions: [hostile],
      validation,
      quality,
      runId: "sec",
    });
    const publicBody = toPublicExtractionResponse(internal);
    expect(publicBody.success).toBe(true);
    if (!publicBody.success) return;
    expect(publicBody.statement.account_number).toBe("****6789");
    expect(String(publicBody.transactions[0].description)).toContain("<script>");
    // Public response must not execute / strip to empty — data preserved, account masked
    expect(maskAccountNumber("0123456789")).toBe("****6789");
  });

  it("does not expose another statement id via status for unknown ids", async () => {
    const app = createApp();
    const res = await request(app).get("/api/v1/statements/other-user-stmt/result");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
