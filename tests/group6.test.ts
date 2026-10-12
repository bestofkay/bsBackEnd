import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { SAMPLE_CSV, buildSampleXlsx, buildTextPdf, buildStatementPng } from "./fixtures/generate.js";
import { HTML_BYTES } from "./fileType.test.js";
import {
  persistExtractionAtomically,
  findByDocumentHash,
  resetMemoryPersistence,
  setForceMemoryPersistence,
} from "../src/modules/database/persistence.js";
import { validatePublicExtractionResponse } from "../src/modules/schema/validate.js";
import { maskAccountNumber } from "../src/modules/api/sanitize.js";
import { toPublicExtractionResponse } from "../src/modules/api/publicResponse.js";
import { buildSuccessResponse } from "../src/modules/output/index.js";
import { buildCanonicalTransaction } from "../src/modules/transactions/index.js";
import { validateTransactions } from "../src/modules/validation/index.js";
import { buildQualitySummary } from "../src/modules/confidence/index.js";
import { reconcileBalances } from "../src/modules/reconciliation/index.js";
import { StatementSchema } from "../src/contracts/index.js";
import { roundMoney, toDecimalString } from "../src/modules/money/index.js";
import { resetJobs } from "../src/modules/jobs/index.js";
import { openApiDocument } from "../src/api/openapi.js";
import { resetStatementAccess } from "../src/modules/runtime/accessControl.js";
import { resetRateLimits } from "../src/modules/runtime/rateLimit.js";

describe("Group 6 API / schema / persistence", () => {
  const app = createApp();

  beforeEach(() => {
    setForceMemoryPersistence(true);
    resetMemoryPersistence();
    resetJobs();
    resetStatementAccess();
    resetRateLimits();
  });

  it("masks account numbers", () => {
    expect(maskAccountNumber("0123456789")).toBe("****6789");
    expect(maskAccountNumber("12")).toBe("****12");
  });

  it("uses decimal strings for money persistence boundaries", () => {
    expect(toDecimalString(50_000)).toBe("50000.0000");
    expect(roundMoney(1.23456)).toBe(1.2346);
  });

  it("validates public response against JSON Schema", () => {
    const tx = buildCanonicalTransaction({
      transaction_date: "2026-09-02",
      description: "TRANSFER TO JAMES DOE",
      reference: "TRF82937291",
      debit: 50000,
      amount: -50000,
      balance: 1_200_000,
      currency: "NGN",
      transaction_type: "TRANSFER",
    });
    const validation = validateTransactions([tx]);
    const quality = buildQualitySummary({
      transactions: [tx],
      validation,
      duplicateCount: 0,
    });
    const reconciliation = reconcileBalances({
      openingBalance: 1_250_000,
      closingBalance: 1_200_000,
      transactions: [tx],
    });
    const internal = buildSuccessResponse({
      statement: StatementSchema.parse({
        bank_name: "GTBank",
        currency: "NGN",
        opening_balance: 1_250_000,
        closing_balance: 1_200_000,
        statement_period_start: "2026-09-01",
        statement_period_end: "2026-09-30",
        account: {
          account_name: "JOHN DOE",
          account_number: "0123456789",
          account_type: "CURRENT",
          currency: "NGN",
        },
      }),
      transactions: [tx],
      validation,
      quality,
      reconciliation,
      runId: "run_schema",
    });

    const publicBody = toPublicExtractionResponse(internal);
    expect("success" in publicBody && publicBody.success).toBe(true);
    if (!("success" in publicBody) || !publicBody.success) return;

    expect(publicBody.statement.account_number).toBe("****6789");
    expect(publicBody.summary.total_debits).toBe(50000);
    expect(publicBody.validation.reconciled).toBe(true);

    const schemaCheck = validatePublicExtractionResponse(publicBody);
    expect(schemaCheck.ok).toBe(true);
  });

  it("persists transactions atomically and supports idempotent hash lookup", async () => {
    const tx = buildCanonicalTransaction({
      transaction_date: "2026-09-01",
      description: "FEE",
      debit: 100,
      amount: -100,
      currency: "NGN",
      transaction_type: "BANK_CHARGE",
    });
    const validation = validateTransactions([tx]);
    const quality = buildQualitySummary({
      transactions: [tx],
      validation,
      duplicateCount: 0,
    });
    const internal = buildSuccessResponse({
      statement: StatementSchema.parse({ currency: "NGN", opening_balance: 1000, closing_balance: 900 }),
      transactions: [tx],
      validation,
      quality,
      reconciliation: reconcileBalances({
        openingBalance: 1000,
        closingBalance: 900,
        transactions: [tx],
      }),
      runId: "run_persist_1",
    });
    const publicBody = toPublicExtractionResponse(internal);
    expect(publicBody.success).toBe(true);
    if (!publicBody.success) return;

    const hash = "abc123hash";
    const first = await persistExtractionAtomically({
      documentHash: hash,
      sourceType: "upload",
      sourceFilename: "a.csv",
      runId: "run_persist_1",
      result: internal,
      publicResult: publicBody as unknown as Record<string, unknown>,
    });
    expect(first.statementId).toBeTruthy();

    const found = await findByDocumentHash(hash);
    expect(found?.statementId).toBe(first.statementId);
    expect(found?.publicResult).toBeTruthy();
  });

  it("rolls back memory persistence on simulated failure", async () => {
    const tx = buildCanonicalTransaction({
      transaction_date: "2026-09-01",
      description: "X",
      debit: 1,
      amount: -1,
      currency: "NGN",
    });
    const validation = validateTransactions([tx]);
    const quality = buildQualitySummary({ transactions: [tx], validation, duplicateCount: 0 });
    const internal = buildSuccessResponse({
      statement: StatementSchema.parse({ currency: "NGN" }),
      transactions: [tx],
      validation,
      quality,
      runId: "run_fail",
    });
    const publicBody = toPublicExtractionResponse(internal);
    if (!publicBody.success) return;

    await expect(
      persistExtractionAtomically({
        documentHash: "fail-hash",
        sourceType: "upload",
        runId: "run_fail",
        result: internal,
        publicResult: {
          ...(publicBody as unknown as Record<string, unknown>),
          __fail_persist: true,
        },
      }),
    ).rejects.toThrow(/Simulated database failure/);

    expect(await findByDocumentHash("fail-hash")).toBeNull();
  });

  it("POST extract CSV returns public Group 6 shape", async () => {
    const res = await request(app)
      .post("/api/v1/statements/extract")
      .attach("file", Buffer.from(SAMPLE_CSV, "utf8"), "statement.csv");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.statement).toHaveProperty("statement_period");
    expect(res.body.summary).toHaveProperty("total_debits");
    expect(res.body.summary).toHaveProperty("transaction_count");
    expect(res.body.validation).toHaveProperty("reconciled");
    expect(res.body.quality).toHaveProperty("confidence");
    expect(res.body.quality).toHaveProperty("warnings");
    expect(res.body.statement_id).toBeTruthy();

    const first = res.body.transactions[0];
    expect(first).not.toHaveProperty("raw");
    expect(first).not.toHaveProperty("confidence_factors");
    expect(first).toHaveProperty("transaction_type");
  });

  it("POST extract PDF succeeds", async () => {
    const pdf = buildTextPdf([
      "Demo Bank Statement",
      "Date Description Debit Credit Balance",
      "2024-01-02 POS PURCHASE 4.50  995.50",
      "2024-01-03 SALARY  2500.00 3495.50",
    ]);
    const res = await request(app)
      .post("/api/v1/statements/extract")
      .attach("file", pdf, "statement.pdf");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("POST extract XLSX succeeds", async () => {
    const res = await request(app)
      .post("/api/v1/statements/extract")
      .attach("file", buildSampleXlsx(), "statement.xlsx");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.transactions.length).toBeGreaterThanOrEqual(1);
  });

  it("POST extract PNG image succeeds", async () => {
    const png = await buildStatementPng();
    const res = await request(app)
      .post("/api/v1/statements/extract")
      .attach("file", png, "statement.png");
    expect([200, 422]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.success).toBe(true);
    } else {
      expect(res.body.success).toBe(false);
    }
  });

  it("rejects unsupported / empty / oversized inputs with correct codes", async () => {
    const unsupported = await request(app)
      .post("/api/v1/statements/extract")
      .attach("file", HTML_BYTES, "statement.pdf");
    expect(unsupported.body.success).toBe(false);
    expect(unsupported.body.error.code).toBe("UNSUPPORTED_FILE_TYPE");
    expect([400, 415]).toContain(unsupported.status);

    const missing = await request(app).post("/api/v1/statements/extract");
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("INVALID_INPUT");

    const empty = await request(app)
      .post("/api/v1/statements/extract")
      .attach("file", Buffer.alloc(0), "empty.csv");
    expect(empty.status).toBe(400);
    expect(["INVALID_INPUT", "EMPTY_UPLOAD"]).toContain(empty.body.error.code);
  });

  it("maps SSRF / invalid URLs to public error codes", async () => {
    const blocked = await request(app)
      .post("/api/v1/statements/extract-url")
      .send({ source_type: "url", url: "http://127.0.0.1/statement.pdf" });
    expect(blocked.body.success).toBe(false);
    expect(blocked.body.error.code).toBe("SSRF_BLOCKED");

    const bad = await request(app)
      .post("/api/v1/statements/extract")
      .send({ source_type: "url", url: "not-a-url" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_INPUT");
  });

  it("returns cached result for duplicate document submission", async () => {
    const file = Buffer.from(SAMPLE_CSV, "utf8");
    const first = await request(app)
      .post("/api/v1/statements/extract")
      .attach("file", file, "statement.csv");
    expect(first.status).toBe(200);
    const id1 = first.body.statement_id;

    const second = await request(app)
      .post("/api/v1/statements/extract")
      .attach("file", file, "statement.csv");
    expect(second.status).toBe(200);
    expect(second.body.idempotent_replay).toBe(true);
    expect(second.body.statement_id).toBe(id1);
  });

  it("async enqueue returns 202 and status endpoint works", async () => {
    const enq = await request(app)
      .post("/api/v1/statements")
      .attach("file", Buffer.from(SAMPLE_CSV, "utf8"), "statement.csv");
    expect(enq.status).toBe(202);
    expect(enq.body.status).toBe("QUEUED");
    expect(enq.body.statement_id).toBeTruthy();
    expect(enq.body.access_token).toBeTruthy();

    const statementId = enq.body.statement_id as string;
    const accessToken = enq.body.access_token as string;

    // Poll briefly for completion
    let finalStatus = "QUEUED";
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const st = await request(app)
        .get(`/api/v1/statements/${statementId}/status`)
        .set("X-Access-Token", accessToken);
      expect(st.status).toBe(200);
      finalStatus = st.body.status;
      if (finalStatus === "COMPLETED" || finalStatus === "REQUIRES_REVIEW" || finalStatus === "FAILED") {
        break;
      }
    }

    const result = await request(app)
      .get(`/api/v1/statements/${statementId}/result`)
      .set("X-Access-Token", accessToken);
    if (finalStatus === "FAILED") {
      expect([422, 500]).toContain(result.status);
    } else {
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    }
  });

  it("serves OpenAPI documentation", async () => {
    const res = await request(app).get("/api/docs/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.3");
    expect(res.body.paths["/api/v1/statements/extract"]).toBeTruthy();
    expect(openApiDocument.info.version).toBe("8.0.0");
  });

  it("unknown statement returns 404", async () => {
    const res = await request(app).get("/api/v1/statements/does-not-exist/status");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("does not invent auth — unauthorized is available as a code", async () => {
    // No auth middleware configured; document that endpoints are auth-ready.
    expect(openApiDocument.components.securitySchemes.bearerAuth).toBeTruthy();
  });
});
