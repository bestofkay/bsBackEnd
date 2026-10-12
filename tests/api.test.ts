import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PDF_BYTES, PNG_BYTES, HTML_BYTES } from "./fileType.test.js";
import { SAMPLE_CSV } from "./fixtures/generate.js";

describe("API v1 extraction endpoints", () => {
  const app = createApp();

  it("GET /api/health returns group 4", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.group).toBe(8);
  });

  it("POST /api/v1/statements/extract returns canonical transactions for CSV", async () => {
    const res = await request(app)
      .post("/api/v1/statements/extract")
      .attach("file", Buffer.from(SAMPLE_CSV, "utf8"), "statement.csv");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.transactions).toBeInstanceOf(Array);
    expect(res.body.transactions.length).toBeGreaterThanOrEqual(3);
    expect(res.body.summary.transaction_count).toBe(res.body.transactions.length);
    expect(res.body.validation).toBeTruthy();
    expect(res.body.quality).toBeTruthy();

    const first = res.body.transactions[0];
    expect(first).toHaveProperty("transaction_date");
    expect(first).toHaveProperty("description");
    expect(first).toHaveProperty("debit");
    expect(first).toHaveProperty("credit");
    expect(first).toHaveProperty("amount");
    expect(first).toHaveProperty("transaction_type");
  });

  it("rejects HTML upload claiming to be PDF", async () => {
    const res = await request(app)
      .post("/api/v1/statements/extract")
      .attach("file", HTML_BYTES, "statement.pdf");
    expect([400, 415]).toContain(res.status);
    expect(res.body.success).toBe(false);
    expect(["UNSUPPORTED_FILE_TYPE", "UNSUPPORTED_CONTENT"]).toContain(res.body.error.code);
  });

  it("rejects missing file", async () => {
    const res = await request(app).post("/api/v1/statements/extract");
    expect(res.status).toBe(400);
    expect(["MISSING_FILE", "INVALID_INPUT"]).toContain(res.body.error.code);
  });

  it("rejects localhost URL on extract-url", async () => {
    const res = await request(app)
      .post("/api/v1/statements/extract-url")
      .send({ source_type: "url", url: "http://127.0.0.1/statement.pdf" });
    expect(res.body.success).toBe(false);
    expect(["URL_HOST_BLOCKED", "SSRF_BLOCKED"]).toContain(res.body.error.code);
  });

  it("rejects file:// and ftp:// URLs", async () => {
    for (const url of ["file:///tmp/a.pdf", "ftp://example.com/a.pdf"]) {
      const res = await request(app)
        .post("/api/v1/statements/extract-url")
        .send({ source_type: "url", url });
      expect(res.body.success).toBe(false);
      expect(["UNSUPPORTED_URL_PROTOCOL", "INVALID_URL", "INVALID_INPUT", "URL_BLOCKED"]).toContain(
        res.body.error.code,
      );
    }
  });

  it("rejects metadata endpoint URL", async () => {
    const res = await request(app)
      .post("/api/v1/statements/extract")
      .send({
        source_type: "url",
        url: "http://169.254.169.254/latest/meta-data",
      });
    expect(res.body.success).toBe(false);
    expect(["URL_HOST_BLOCKED", "SSRF_BLOCKED"]).toContain(res.body.error.code);
  });

  it("smoke fixture constants", () => {
    expect(PDF_BYTES.length).toBeGreaterThan(4);
    expect(PNG_BYTES.length).toBeGreaterThan(8);
  });
});
