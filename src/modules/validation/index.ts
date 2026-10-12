/**
 * Statement / transaction validation (Group 5).
 * Includes structural checks and running-balance progression.
 * Never mutates extracted values.
 */

import {
  ValidationResultSchema,
  type Transaction,
  type ValidationIssue,
  type ValidationResult,
} from "../../contracts/index.js";

/** Tolerate 1 kobo of float/bank rounding noise on running balances. */
const BALANCE_EPS_CENTS = 1;

function toCents(n: number): number {
  return Math.round(n * 100);
}

function push(
  issues: ValidationIssue[],
  issue: Omit<ValidationIssue, "transaction_index" | "field"> & {
    transaction_index?: number | null;
    field?: string | null;
  },
): void {
  issues.push({
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    transaction_index: issue.transaction_index ?? null,
    field: issue.field ?? null,
  });
}

function signedDelta(tx: Transaction): number | null {
  if (tx.amount != null) return tx.amount;
  const debit = tx.debit != null ? Math.abs(tx.debit) : null;
  const credit = tx.credit != null ? Math.abs(tx.credit) : null;
  if (debit == null && credit == null) return null;
  return (credit ?? 0) - (debit ?? 0);
}

function isImpossibleAmount(tx: Transaction): boolean {
  const vals = [tx.debit, tx.credit, tx.amount, tx.balance].filter(
    (v): v is number => typeof v === "number",
  );
  return vals.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e15);
}

function isInvalidDate(value: string | null): boolean {
  if (value == null) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return true;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d;
}

/**
 * Transaction-level structural validation (Group 1 foundation + Group 5 codes).
 */
export function validateTransactions(transactions: Transaction[]): ValidationResult {
  const issues: ValidationIssue[] = [];

  transactions.forEach((tx, index) => {
    if (tx.transaction_date == null && tx.value_date == null && tx.posting_date == null) {
      push(issues, {
        code: "INCOMPLETE_TRANSACTION",
        message: "Transaction has no transaction_date, value_date, or posting_date",
        severity: "warning",
        transaction_index: index,
        field: "transaction_date",
      });
      push(issues, {
        code: "MISSING_DATE",
        message: "Transaction has no date fields",
        severity: "warning",
        transaction_index: index,
        field: "transaction_date",
      });
    }

    for (const [field, value] of [
      ["transaction_date", tx.transaction_date],
      ["value_date", tx.value_date],
      ["posting_date", tx.posting_date],
    ] as const) {
      if (value && isInvalidDate(value)) {
        push(issues, {
          code: "AMBIGUOUS_DATE",
          message: `Invalid or malformed ${field}: ${value}`,
          severity: "warning",
          transaction_index: index,
          field,
        });
      }
    }

    if (tx.debit == null && tx.credit == null && tx.amount == null) {
      push(issues, {
        code: "INCOMPLETE_TRANSACTION",
        message: "Transaction has no debit, credit, or amount",
        severity: "error",
        transaction_index: index,
        field: "amount",
      });
      push(issues, {
        code: "MISSING_AMOUNT",
        message: "Transaction has no amount fields",
        severity: "error",
        transaction_index: index,
        field: "amount",
      });
    }

    if (isImpossibleAmount(tx)) {
      push(issues, {
        code: "IMPOSSIBLE_AMOUNT",
        message: "Transaction contains non-finite or implausible amount values",
        severity: "error",
        transaction_index: index,
        field: "amount",
      });
    }

    if (tx.debit != null && tx.credit != null && tx.debit !== 0 && tx.credit !== 0) {
      push(issues, {
        code: "BOTH_DEBIT_AND_CREDIT",
        message: "Transaction has both non-zero debit and credit",
        severity: "warning",
        transaction_index: index,
        field: "debit",
      });
    }

    if (tx.description == null || tx.description.trim() === "") {
      push(issues, {
        code: "MISSING_DESCRIPTION",
        message: "Transaction description is empty",
        severity: "info",
        transaction_index: index,
        field: "description",
      });
    }

    if (tx.reference == null || tx.reference.trim() === "") {
      push(issues, {
        code: "MISSING_REFERENCE",
        message: "Transaction reference is missing",
        severity: "info",
        transaction_index: index,
        field: "reference",
      });
    }

    if (tx.balance == null) {
      push(issues, {
        code: "MISSING_BALANCE",
        message: "Running balance is missing",
        severity: "info",
        transaction_index: index,
        field: "balance",
      });
    }

    if (tx.transaction_type === "UNKNOWN" || tx.transaction_type == null) {
      push(issues, {
        code: "UNKNOWN_TRANSACTION_TYPE",
        message: "Transaction type could not be classified confidently",
        severity: "info",
        transaction_index: index,
        field: "transaction_type",
      });
    }

    if (tx.duplicate_suspected) {
      push(issues, {
        code: "POSSIBLE_DUPLICATE",
        message: `Possible duplicate (group ${tx.duplicate_group_id ?? "unknown"})`,
        severity: "warning",
        transaction_index: index,
        field: null,
      });
    }

    const ocr = tx.raw?.ocr_confidence;
    if (typeof ocr === "number" && ocr < 0.55) {
      push(issues, {
        code: "OCR_LOW_CONFIDENCE",
        message: `OCR confidence ${ocr} is low for this transaction`,
        severity: "warning",
        transaction_index: index,
        field: null,
      });
    }
  });

  const hasErrors = issues.some((i) => i.severity === "error");
  return ValidationResultSchema.parse({
    is_valid: !hasErrors,
    issues,
    checked_at: new Date().toISOString(),
  });
}

/**
 * Validate running-balance progression when balances are present.
 * Does not modify extracted balances.
 */
export function validateBalanceProgression(
  transactions: Transaction[],
  openingBalance: number | null = null,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let previous: number | null = openingBalance;

  transactions.forEach((tx, index) => {
    if (tx.balance == null) {
      // Cannot validate this step; update previous only if we can compute
      const delta = signedDelta(tx);
      if (previous != null && delta != null) {
        previous = previous + delta;
      }
      return;
    }

    if (previous != null) {
      const delta = signedDelta(tx);
      if (delta != null) {
        const expectedCents = toCents(previous) + toCents(delta);
        const actualCents = toCents(tx.balance);
        const driftCents = Math.abs(expectedCents - actualCents);
        if (driftCents > BALANCE_EPS_CENTS) {
          const expected = expectedCents / 100;
          push(issues, {
            code: "BALANCE_MISMATCH",
            message: `Expected running balance ${expected} but found ${tx.balance}`,
            severity: "warning",
            transaction_index: index,
            field: "balance",
          });
        }
      }
    }

    previous = tx.balance;
  });

  return issues;
}

export function validateStatement(params: {
  transactions: Transaction[];
  openingBalance?: number | null;
  closingBalance?: number | null;
  expectedTransactionCount?: number | null;
}): ValidationResult {
  const base = validateTransactions(params.transactions);
  const issues = [...base.issues];

  issues.push(
    ...validateBalanceProgression(
      params.transactions,
      params.openingBalance ?? null,
    ),
  );

  if (
    params.expectedTransactionCount != null &&
    params.expectedTransactionCount !== params.transactions.length
  ) {
    push(issues, {
      code: "TRANSACTION_COUNT_MISMATCH",
      message: `Expected ${params.expectedTransactionCount} transactions but found ${params.transactions.length}`,
      severity: "warning",
    });
  }

  let debitTotal = 0;
  let creditTotal = 0;
  let hasDebit = false;
  let hasCredit = false;
  for (const tx of params.transactions) {
    if (tx.debit != null) {
      debitTotal += Math.abs(tx.debit);
      hasDebit = true;
    }
    if (tx.credit != null) {
      creditTotal += Math.abs(tx.credit);
      hasCredit = true;
    }
  }

  if (hasDebit && debitTotal < 0) {
    push(issues, {
      code: "IMPOSSIBLE_AMOUNT",
      message: "Aggregate debit total is negative",
      severity: "error",
    });
  }
  if (hasCredit && creditTotal < 0) {
    push(issues, {
      code: "IMPOSSIBLE_AMOUNT",
      message: "Aggregate credit total is negative",
      severity: "error",
    });
  }

  const hasErrors = issues.some((i) => i.severity === "error");
  return ValidationResultSchema.parse({
    is_valid: !hasErrors,
    issues,
    checked_at: new Date().toISOString(),
  });
}
