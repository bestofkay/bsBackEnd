/**
 * Normalization — descriptions, currency, dates, amounts, types.
 * Does not invent missing money values.
 */

import type { Transaction } from "../../contracts/index.js";
import { TransactionSchema } from "../../contracts/index.js";

export { normalizeDate, parseDate, looksLikeDate, extractDateFromText } from "./dates.js";
export {
  parseAmount,
  looksLikeAmount,
  normalizeDebitCreditAmount,
} from "./amounts.js";
export { classifyTransactionType } from "./types.js";

export function normalizeDescription(value: string | null): string | null {
  if (value == null) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length === 0 ? null : collapsed;
}

export function normalizeCurrency(value: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim().toUpperCase();
  // Strip symbols-only leftovers
  if (/^[₦$£€]+$/.test(trimmed)) return null;
  return trimmed.length === 0 ? null : trimmed;
}

export function normalizeTransaction(tx: Transaction): Transaction {
  return TransactionSchema.parse({
    ...tx,
    description: normalizeDescription(tx.description),
    reference: normalizeDescription(tx.reference),
    currency: normalizeCurrency(tx.currency),
  });
}

export function normalizeTransactions(transactions: Transaction[]): Transaction[] {
  return transactions.map(normalizeTransaction);
}
