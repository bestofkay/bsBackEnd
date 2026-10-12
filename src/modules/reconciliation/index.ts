/**
 * Balance reconciliation (Group 5).
 * Never mutates extracted transactions to force a reconcile.
 */

import {
  ReconciliationResultSchema,
  type ReconciliationResult,
  type Transaction,
} from "../../contracts/index.js";

export type ReconciliationStatus = "RECONCILED" | "MISMATCH" | "NOT_DETERMINABLE";

const EPS = 0.01;

function round4(n: number): number {
  return Number(n.toFixed(4));
}

function signedDelta(tx: Transaction): number | null {
  if (tx.amount != null) return tx.amount;
  const debit = tx.debit != null ? Math.abs(tx.debit) : null;
  const credit = tx.credit != null ? Math.abs(tx.credit) : null;
  if (debit == null && credit == null) return null;
  return (credit ?? 0) - (debit ?? 0);
}

/**
 * Expected closing = opening + credits - debits (via signed amounts).
 */
export function reconcileBalances(params: {
  openingBalance: number | null;
  closingBalance: number | null;
  transactions: Transaction[];
}): ReconciliationResult {
  const { openingBalance, closingBalance, transactions } = params;

  if (openingBalance == null || closingBalance == null) {
    return ReconciliationResultSchema.parse({
      is_reconciled: false,
      reconciled: false,
      reconciliation_status: "NOT_DETERMINABLE",
      opening_balance: openingBalance,
      closing_balance: closingBalance,
      statement_closing_balance: closingBalance,
      computed_closing_balance: null,
      calculated_closing_balance: null,
      difference: null,
      method: "insufficient_balances",
      notes: [
        "Opening and/or closing balance unavailable; reconciliation cannot be determined safely",
      ],
    });
  }

  let running = openingBalance;
  let missingSigned = 0;
  let usedSignedAmount = false;
  let usedDebitCredit = false;

  for (const tx of transactions) {
    const delta = signedDelta(tx);
    if (delta == null) {
      missingSigned += 1;
      continue;
    }
    if (tx.amount != null) usedSignedAmount = true;
    else usedDebitCredit = true;
    running += delta;
  }

  // Too many incomplete money rows → do not claim reconcile true/false confidently
  if (missingSigned > 0 && missingSigned / Math.max(transactions.length, 1) > 0.25) {
    return ReconciliationResultSchema.parse({
      is_reconciled: false,
      reconciled: false,
      reconciliation_status: "NOT_DETERMINABLE",
      opening_balance: openingBalance,
      closing_balance: closingBalance,
      statement_closing_balance: closingBalance,
      computed_closing_balance: round4(running),
      calculated_closing_balance: round4(running),
      difference: round4(running - closingBalance),
      method: "incomplete_transactions",
      notes: [
        `${missingSigned} transaction(s) lack debit/credit/amount; reconciliation is not determinable`,
      ],
    });
  }

  const calculated = round4(running);
  const difference = round4(calculated - closingBalance);
  const matched = Math.abs(difference) <= EPS;
  const status: ReconciliationStatus = matched ? "RECONCILED" : "MISMATCH";

  return ReconciliationResultSchema.parse({
    is_reconciled: matched,
    reconciled: matched,
    reconciliation_status: status,
    opening_balance: openingBalance,
    closing_balance: closingBalance,
    statement_closing_balance: closingBalance,
    computed_closing_balance: calculated,
    calculated_closing_balance: calculated,
    difference,
    method: usedSignedAmount
      ? "signed_amount"
      : usedDebitCredit
        ? "debit_credit"
        : "mixed",
    notes: matched
      ? []
      : [
          "Calculated closing balance does not match statement closing balance",
          "Extracted transactions were not modified to force reconciliation",
        ],
  });
}
