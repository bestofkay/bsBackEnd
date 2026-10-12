import { describe, expect, it } from "vitest";
import {
  TransactionSchema,
  ExtractionResultSchema,
  ErrorResponseSchema,
  DocumentInputSchema,
} from "../src/contracts/index.js";
import { buildCanonicalTransaction } from "../src/modules/transactions/index.js";
import { createErrorResponse, buildSuccessResponse } from "../src/modules/output/index.js";
import { validateDocumentInput } from "../src/modules/security/index.js";
import { createUploadDocumentInput, createUrlDocumentInput } from "../src/modules/ingestion/index.js";
import { validateTransactions } from "../src/modules/validation/index.js";
import { buildQualitySummary } from "../src/modules/confidence/index.js";
import { StatementSchema } from "../src/contracts/index.js";

describe("canonical Transaction model", () => {
  it("keeps missing financial fields null and does not invent values", () => {
    const tx = buildCanonicalTransaction({
      description: "ATM WITHDRAWAL",
      transaction_date: "2024-01-15",
    });

    expect(tx.debit).toBeNull();
    expect(tx.credit).toBeNull();
    expect(tx.amount).toBeNull();
    expect(tx.balance).toBeNull();
    expect(tx.value_date).toBeNull();
    expect(tx.posting_date).toBeNull();
    expect(tx.currency).toBeNull();
    expect(tx.reference).toBeNull();
    expect(tx.transaction_type).toBe("UNKNOWN");
    expect(TransactionSchema.safeParse(tx).success).toBe(true);
  });

  it("derives signed amount only from debit or credit when amount is absent", () => {
    const debitTx = buildCanonicalTransaction({ debit: 100.5 });
    expect(debitTx.amount).toBe(-100.5);
    expect(debitTx.transaction_type).toBe("UNKNOWN");

    const creditTx = buildCanonicalTransaction({ credit: 50 });
    expect(creditTx.amount).toBe(50);
    expect(creditTx.transaction_type).toBe("UNKNOWN");
  });

  it("derives credit/debit sides from signed amount when sides are absent", () => {
    const inTx = buildCanonicalTransaction({ amount: 250 });
    expect(inTx.credit).toBe(250);
    expect(inTx.debit).toBeNull();

    const outTx = buildCanonicalTransaction({ amount: -80 });
    expect(outTx.debit).toBe(80);
    expect(outTx.credit).toBeNull();
  });

  it("rejects fabricated non-nullable required shapes via schema", () => {
    const result = TransactionSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("ExtractionResult model", () => {
  it("validates a successful response contract", () => {
    const tx = buildCanonicalTransaction({
      transaction_date: "2024-02-01",
      description: "Salary",
      credit: 1000,
      currency: "NGN",
    });
    const validation = validateTransactions([tx]);
    const quality = buildQualitySummary({
      transactions: [tx],
      validation,
      duplicateCount: 0,
    });

    const result = buildSuccessResponse({
      statement: StatementSchema.parse({
        currency: "NGN",
      }),
      transactions: [tx],
      validation,
      quality,
      runId: "run_test",
    });

    expect(result.success).toBe(true);
    expect(result.transactions).toHaveLength(1);
    expect(result.summary.transaction_count).toBe(1);
    expect(ExtractionResultSchema.safeParse(result).success).toBe(true);
  });
});

describe("error response", () => {
  it("matches the failed processing contract", () => {
    const error = createErrorResponse("EXTRACTION_NOT_IMPLEMENTED", "Not ready", {
      group: 1,
    });
    expect(error).toEqual({
      success: false,
      error: {
        code: "EXTRACTION_NOT_IMPLEMENTED",
        message: "Not ready",
        details: { group: 1 },
      },
    });
    expect(ErrorResponseSchema.safeParse(error).success).toBe(true);
  });
});

describe("input validation", () => {
  it("requires source_url when source_type is url", () => {
    const parsed = DocumentInputSchema.safeParse({
      document_id: "stmt_test",
      source_type: "url",
      source_url: null,
      url: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts upload document inputs", () => {
    const doc = createUploadDocumentInput({
      filename: "statement.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      localPath: "/tmp/statement.pdf",
    });
    expect(doc.source_type).toBe("upload");
    expect(doc.extension).toBe("pdf");
    expect(doc.mime_type).toBe("application/pdf");
    expect(doc.document_id).toMatch(/^stmt_/);
  });

  it("rejects oversized uploads at the security gate", () => {
    const doc = createUploadDocumentInput({
      filename: "big.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10_000_000,
      localPath: "/tmp/big.pdf",
    });
    const result = validateDocumentInput(doc, {
      maxUploadBytes: 1000,
      maxDownloadBytes: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("FILE_TOO_LARGE");
    }
  });

  it("rejects documents missing a local path", () => {
    const parsed = DocumentInputSchema.parse({
      document_id: "stmt_x",
      source_type: "upload",
      original_filename: "a.pdf",
      mime_type: "application/pdf",
      extension: "pdf",
      local_path: null,
      file_size: 10,
    });
    const result = validateDocumentInput(parsed, {
      maxUploadBytes: 1000,
      maxDownloadBytes: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("MISSING_LOCAL_DOCUMENT");
    }
  });

  it("accepts materialized URL documents", () => {
    const doc = createUrlDocumentInput({
      url: "https://files.example.com/statement.pdf",
      localPath: "/tmp/downloaded.pdf",
      fileSize: 2048,
    });
    const result = validateDocumentInput(doc, {
      maxUploadBytes: 26_214_400,
      maxDownloadBytes: 26_214_400,
    });
    expect(result.ok).toBe(true);
  });
});
