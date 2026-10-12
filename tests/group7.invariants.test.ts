/**
 * Group 7 — invariants, persistence integrity, schema, decimal precision.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { buildCanonicalTransaction } from "../src/modules/transactions/index.js";
import { normalizeDebitCreditAmount } from "../src/modules/normalization/amounts.js";
import { reconcileBalances } from "../src/modules/reconciliation/index.js";
import {
  persistExtractionAtomically,
  findByDocumentHash,
  findPersistedByStatementId,
  resetMemoryPersistence,
  setForceMemoryPersistence,
} from "../src/modules/database/persistence.js";
import { toPublicExtractionResponse } from "../src/modules/api/publicResponse.js";
import { validatePublicExtractionResponse } from "../src/modules/schema/validate.js";
import { buildSuccessResponse } from "../src/modules/output/index.js";
import { validateTransactions } from "../src/modules/validation/index.js";
import { buildQualitySummary } from "../src/modules/confidence/index.js";
import { StatementSchema, type Transaction } from "../src/contracts/index.js";
import { toDecimalString, roundMoney } from "../src/modules/money/index.js";
import request from "supertest";
import { createApp } from "../src/app.js";
import { SAMPLE_CSV } from "./fixtures/generate.js";
import { resetRateLimits } from "../src/modules/runtime/rateLimit.js";
import { resetStatementAccess } from "../src/modules/runtime/accessControl.js";

function makeInternal(transactions: Transaction[], opening: number, closing: number) {
  const validation = validateTransactions(transactions);
  const quality = buildQualitySummary({
    transactions,
    validation,
    duplicateCount: 0,
  });
  const reconciliation = reconcileBalances({
    openingBalance: opening,
    closingBalance: closing,
    transactions,
  });
  return buildSuccessResponse({
    statement: StatementSchema.parse({
      currency: "NGN",
      opening_balance: opening,
      closing_balance: closing,
      account: { account_number: "9988776655", account_name: "SYNTHETIC USER" },
    }),
    transactions,
    validation,
    quality,
    reconciliation,
    runId: `inv_${Date.now()}`,
  });
}

describe("Group 7 invariants", () => {
  beforeEach(() => {
    setForceMemoryPersistence(true);
    resetMemoryPersistence();
    resetRateLimits();
    resetStatementAccess();
  });

  it("amount = credit - debit when both sides present", () => {
    const triad = normalizeDebitCreditAmount({ debit: 40, credit: 100 });
    expect(triad.amount).toBe(60);
    const tx = buildCanonicalTransaction({ debit: 40, credit: 100 });
    expect(tx.amount).toBe(60);
  });

  it("reconciled statements satisfy opening + credits - debits = closing", () => {
    const transactions = [
      buildCanonicalTransaction({
        transaction_date: "2026-09-01",
        description: "IN",
        credit: 200,
        amount: 200,
      }),
      buildCanonicalTransaction({
        transaction_date: "2026-09-02",
        description: "OUT",
        debit: 50,
        amount: -50,
      }),
    ];
    const opening = 1000;
    const closing = 1150;
    const r = reconcileBalances({ openingBalance: opening, closingBalance: closing, transactions });
    expect(r.reconciliation_status).toBe("RECONCILED");
    const credits = transactions.reduce((s, t) => s + (t.credit ?? 0), 0);
    const debits = transactions.reduce((s, t) => s + (t.debit ?? 0), 0);
    expect(opening + credits - debits).toBe(closing);
  });

  it("every successful public API response validates against JSON Schema", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/v1/statements/extract")
      .attach("file", Buffer.from(SAMPLE_CSV, "utf8"), "statement.csv");
    expect(res.status).toBe(200);
    const schema = validatePublicExtractionResponse(res.body);
    expect(schema.ok).toBe(true);
  });

  it("persisted transactions always reference an existing statement; rollback leaves no hash", async () => {
    const tx = buildCanonicalTransaction({
      transaction_date: "2026-09-01",
      description: "FEE",
      debit: 12.34,
      amount: -12.34,
      currency: "NGN",
    });
    const internal = makeInternal([tx], 100, 87.66);
    const publicBody = toPublicExtractionResponse(internal);
    expect(publicBody.success).toBe(true);
    if (!publicBody.success) return;

    const ok = await persistExtractionAtomically({
      documentHash: "hash-ok-1",
      sourceType: "upload",
      runId: "run-ok",
      result: internal,
      publicResult: publicBody as unknown as Record<string, unknown>,
    });
    const found = await findPersistedByStatementId(ok.statementId);
    expect(found?.statementId).toBe(ok.statementId);
    expect(found?.publicResult).toBeTruthy();

    await expect(
      persistExtractionAtomically({
        documentHash: "hash-fail-1",
        sourceType: "upload",
        runId: "run-fail",
        result: internal,
        publicResult: {
          ...(publicBody as unknown as Record<string, unknown>),
          __fail_persist: true,
        },
      }),
    ).rejects.toThrow();
    expect(await findByDocumentHash("hash-fail-1")).toBeNull();
  });

  it("stores money via exact decimal strings (no binary float drift at boundary)", () => {
    expect(toDecimalString(50_000)).toBe("50000.0000");
    expect(toDecimalString(12.345)).toBe("12.3450");
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
  });

  it("idempotent document hash returns same statement without fabricating new txs", async () => {
    const app = createApp();
    const file = Buffer.from(SAMPLE_CSV, "utf8");
    const a = await request(app)
      .post("/api/v1/statements/extract")
      .attach("file", file, "statement.csv");
    const b = await request(app)
      .post("/api/v1/statements/extract")
      .attach("file", file, "statement.csv");
    expect(a.body.statement_id).toBe(b.body.statement_id);
    expect(b.body.idempotent_replay).toBe(true);
    expect(a.body.summary.transaction_count).toBe(b.body.summary.transaction_count);
  });
});
