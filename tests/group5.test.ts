import { describe, expect, it } from "vitest";
import { buildCanonicalTransaction } from "../src/modules/transactions/index.js";
import {
  applyDuplicateFlags,
  detectDuplicates,
} from "../src/modules/duplicates/index.js";
import {
  applyConfidenceScores,
  buildQualitySummary,
  scoreAllTransactions,
  scoreTransactionConfidenceDetailed,
} from "../src/modules/confidence/index.js";
import { reconcileBalances } from "../src/modules/reconciliation/index.js";
import {
  validateBalanceProgression,
  validateStatement,
  validateTransactions,
} from "../src/modules/validation/index.js";
import type { Transaction } from "../src/contracts/index.js";

function tx(partial: Parameters<typeof buildCanonicalTransaction>[0]): Transaction {
  return buildCanonicalTransaction(partial);
}

describe("duplicate detection", () => {
  it("flags exact duplicates (same date, amount, reference, account)", () => {
    const transactions = [
      tx({
        transaction_date: "2026-09-01",
        description: "TRANSFER OUT",
        amount: -100000,
        debit: 100000,
        reference: "REF-EXACT-1",
        currency: "NGN",
      }),
      tx({
        transaction_date: "2026-09-01",
        description: "TRANSFER OUT",
        amount: -100000,
        debit: 100000,
        reference: "REF-EXACT-1",
        currency: "NGN",
      }),
    ];

    const result = detectDuplicates(transactions, { accountId: "ACC-001" });
    const flagged = applyDuplicateFlags(transactions, result);

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(flagged[0].duplicate_suspected).toBe(true);
    expect(flagged[1].duplicate_suspected).toBe(true);
    expect(flagged[0].duplicate_group_id).toBe(flagged[1].duplicate_group_id);
    expect(flagged[0].duplicate_group_id).toMatch(/^dup_/);
    // Original financial values intact
    expect(flagged[0].amount).toBe(-100000);
    expect(flagged[1].reference).toBe("REF-EXACT-1");
  });

  it("does not flag same description with different date and reference", () => {
    const transactions = [
      tx({
        transaction_date: "2026-09-01",
        description: "TRANSFER TO JOHN",
        amount: -50000,
        debit: 50000,
        reference: "REF001",
        currency: "NGN",
      }),
      tx({
        transaction_date: "2026-09-02",
        description: "TRANSFER TO JOHN",
        amount: -50000,
        debit: 50000,
        reference: "REF002",
        currency: "NGN",
      }),
    ];

    const result = detectDuplicates(transactions, { accountId: "ACC-001" });
    const flagged = applyDuplicateFlags(transactions, result);

    expect(flagged.every((t) => t.duplicate_suspected === false)).toBe(true);
    expect(result.candidates).toHaveLength(0);
  });

  it("does not flag same amount alone as a duplicate", () => {
    const transactions = [
      tx({
        transaction_date: "2026-09-01",
        description: "POS SHOP A",
        amount: -2500,
        debit: 2500,
        reference: "POS-A",
        currency: "NGN",
      }),
      tx({
        transaction_date: "2026-09-10",
        description: "POS SHOP B",
        amount: -2500,
        debit: 2500,
        reference: "POS-B",
        currency: "NGN",
      }),
    ];

    const result = detectDuplicates(transactions);
    expect(result.candidates).toHaveLength(0);
    expect(applyDuplicateFlags(transactions, result).every((t) => !t.duplicate_suspected)).toBe(
      true,
    );
  });

  it("treats legitimate repeated transfers as non-duplicates", () => {
    const transactions = [
      tx({
        transaction_date: "2026-09-01",
        description: "TRANSFER TO JOHN",
        amount: -50000,
        debit: 50000,
        reference: "REF001",
        currency: "NGN",
      }),
      tx({
        transaction_date: "2026-09-02",
        description: "TRANSFER TO JOHN",
        amount: -50000,
        debit: 50000,
        reference: "REF002",
        currency: "NGN",
      }),
    ];

    const flagged = applyDuplicateFlags(
      transactions,
      detectDuplicates(transactions, { accountId: "0123456789" }),
    );
    expect(flagged[0].duplicate_suspected).toBe(false);
    expect(flagged[1].duplicate_suspected).toBe(false);
  });

  it("detects page-overlap style duplicates (same row, no distinct refs)", () => {
    const shared = {
      transaction_date: "2026-09-15",
      description: "STANDING ORDER UTILITY PAYMENT",
      amount: -12500.5,
      debit: 12500.5,
      currency: "NGN",
      balance: 987499.5,
      reference: null as string | null,
    };
    const transactions = [tx(shared), tx(shared)];

    const result = detectDuplicates(transactions, { accountId: "ACC-9" });
    const flagged = applyDuplicateFlags(transactions, result);

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(flagged[0].duplicate_suspected).toBe(true);
    expect(flagged[1].duplicate_suspected).toBe(true);
  });

  it("never deletes transactions when duplicates are suspected", () => {
    const transactions = [
      tx({
        transaction_date: "2026-01-01",
        description: "FEE",
        amount: -100,
        debit: 100,
        reference: "FEE-1",
      }),
      tx({
        transaction_date: "2026-01-01",
        description: "FEE",
        amount: -100,
        debit: 100,
        reference: "FEE-1",
      }),
    ];
    const flagged = applyDuplicateFlags(transactions, detectDuplicates(transactions));
    expect(flagged).toHaveLength(2);
  });
});

describe("confidence engine", () => {
  it("scores complete transactions higher than incomplete ones", () => {
    const complete = tx({
      transaction_date: "2026-09-01",
      description: "SALARY CREDIT SEPTEMBER",
      credit: 500000,
      amount: 500000,
      balance: 1500000,
      reference: "PAY-SEP",
      currency: "NGN",
      transaction_type: "SALARY",
      raw: { parser_confidence: 0.95 },
    });
    const incomplete = tx({
      description: "x",
    });

    const high = scoreTransactionConfidenceDetailed(complete, 0, null);
    const low = scoreTransactionConfidenceDetailed(incomplete, 1, null);

    expect(high.confidence).toBeGreaterThan(low.confidence);
    expect(high.factors.date).toBe(1);
    expect(high.factors.amount).toBe(1);
    expect(Object.keys(high.factors).length).toBeGreaterThanOrEqual(8);
  });

  it("builds a quality summary with review counts and warnings", () => {
    const good = tx({
      transaction_date: "2026-09-01",
      description: "TRANSFER IN FROM PAYROLL",
      credit: 1000,
      amount: 1000,
      balance: 2000,
      reference: "R1",
      currency: "NGN",
      transaction_type: "TRANSFER",
      raw: { parser_confidence: 0.9 },
    });
    const weak = tx({ description: "z" });
    const transactions = [good, weak];
    const validation = validateTransactions(transactions);
    const scored = scoreAllTransactions(transactions, validation);
    const withScores = applyConfidenceScores(transactions, scored);
    const quality = buildQualitySummary({
      transactions: withScores,
      validation,
      duplicateCount: 0,
      scored,
    });

    expect(quality.confidence).not.toBeNull();
    expect(quality.confidence!).toBeGreaterThan(0);
    expect(quality.confidence!).toBeLessThanOrEqual(1);
    expect(quality.transactions_requiring_review).toBeGreaterThanOrEqual(1);
    expect(quality.warnings.some((w) => w.code === "LOW_CONFIDENCE_TRANSACTION")).toBe(true);
    expect(withScores[0].confidence).not.toBeNull();
  });
});

describe("reconciliation", () => {
  it("reconciles when opening + credits - debits equals closing", () => {
    const transactions = [
      tx({
        transaction_date: "2026-09-01",
        description: "Credit in",
        credit: 100000,
        amount: 100000,
      }),
      tx({
        transaction_date: "2026-09-02",
        description: "Debit out",
        debit: 25000,
        amount: -25000,
      }),
    ];

    const result = reconcileBalances({
      openingBalance: 1710000,
      closingBalance: 1785000,
      transactions,
    });

    expect(result.reconciled).toBe(true);
    expect(result.is_reconciled).toBe(true);
    expect(result.reconciliation_status).toBe("RECONCILED");
    expect(result.calculated_closing_balance).toBe(1785000);
    expect(result.statement_closing_balance).toBe(1785000);
    expect(result.difference).toBe(0);
  });

  it("reports mismatch without mutating transactions", () => {
    const transactions = [
      tx({
        transaction_date: "2026-09-01",
        description: "Credit in",
        credit: 50000,
        amount: 50000,
      }),
    ];
    const originalAmount = transactions[0].amount;

    const result = reconcileBalances({
      openingBalance: 1710000,
      closingBalance: 1785000,
      transactions,
    });

    expect(result.reconciled).toBe(false);
    expect(result.reconciliation_status).toBe("MISMATCH");
    expect(result.calculated_closing_balance).toBe(1760000);
    expect(result.statement_closing_balance).toBe(1785000);
    expect(result.difference).toBe(-25000);
    expect(transactions[0].amount).toBe(originalAmount);
  });

  it("returns NOT_DETERMINABLE when balances are missing", () => {
    const result = reconcileBalances({
      openingBalance: null,
      closingBalance: 1000,
      transactions: [
        tx({
          transaction_date: "2026-09-01",
          description: "x",
          credit: 10,
          amount: 10,
        }),
      ],
    });

    expect(result.reconciliation_status).toBe("NOT_DETERMINABLE");
    expect(result.reconciled).toBe(false);
    expect(result.is_reconciled).toBe(false);
  });

  it("returns NOT_DETERMINABLE when too many transactions lack money fields", () => {
    const transactions = [
      tx({ transaction_date: "2026-09-01", description: "a" }),
      tx({ transaction_date: "2026-09-02", description: "b" }),
      tx({
        transaction_date: "2026-09-03",
        description: "c",
        credit: 10,
        amount: 10,
      }),
    ];

    const result = reconcileBalances({
      openingBalance: 100,
      closingBalance: 110,
      transactions,
    });

    expect(result.reconciliation_status).toBe("NOT_DETERMINABLE");
    expect(result.reconciled).toBe(false);
  });
});

describe("validation", () => {
  it("validates running balance progression", () => {
    const transactions = [
      tx({
        transaction_date: "2026-09-01",
        description: "Debit",
        debit: 50000,
        amount: -50000,
        balance: 950000,
      }),
      tx({
        transaction_date: "2026-09-02",
        description: "Bad balance",
        debit: 10000,
        amount: -10000,
        balance: 970000,
      }),
    ];

    const issues = validateBalanceProgression(transactions, 1_000_000);
    expect(issues.some((i) => i.code === "BALANCE_MISMATCH" && i.transaction_index === 1)).toBe(
      true,
    );
    expect(issues.some((i) => i.transaction_index === 0 && i.code === "BALANCE_MISMATCH")).toBe(
      false,
    );
    // Does not mutate
    expect(transactions[1].balance).toBe(970000);
  });

  it("emits machine-readable warning codes for incomplete rows", () => {
    const validation = validateStatement({
      transactions: [
        tx({ description: "incomplete row" }),
        tx({
          transaction_date: "2026-13-40",
          description: "bad date",
          debit: 10,
          amount: -10,
        }),
      ],
      openingBalance: 100,
      closingBalance: 90,
    });

    const codes = new Set(validation.issues.map((i) => i.code));
    expect(codes.has("INCOMPLETE_TRANSACTION") || codes.has("MISSING_AMOUNT")).toBe(true);
    expect(codes.has("AMBIGUOUS_DATE")).toBe(true);
    expect(validation.is_valid).toBe(false);
  });

  it("flags possible duplicates during statement validation", () => {
    const a: Transaction = {
      ...tx({
        transaction_date: "2026-09-01",
        description: "FEE CHARGE",
        debit: 100,
        amount: -100,
        reference: "DUP-R",
      }),
      duplicate_suspected: true,
      duplicate_group_id: "dup_00001",
    };
    const validation = validateTransactions([a]);
    expect(validation.issues.some((i) => i.code === "POSSIBLE_DUPLICATE")).toBe(true);
  });
});
