/**
 * Canonical transaction builder.
 * Missing financial fields stay null — never invented.
 */

import { randomUUID } from "node:crypto";
import {
  TransactionSchema,
  type Transaction,
  type TransactionType,
} from "../../contracts/index.js";

export type RawTransactionDraft = {
  transaction_date?: string | null;
  value_date?: string | null;
  posting_date?: string | null;
  description?: string | null;
  reference?: string | null;
  debit?: number | null;
  credit?: number | null;
  amount?: number | null;
  balance?: number | null;
  currency?: string | null;
  transaction_type?: TransactionType | null;
  raw?: Record<string, unknown>;
};

/**
 * Creates a canonical transaction. Missing fields stay null unless implied.
 * - Amount is derived when debit/credit imply a signed value.
 * - Debit/credit are derived from signed amount when sides are absent.
 */
export function buildCanonicalTransaction(draft: RawTransactionDraft): Transaction {
  let debit = draft.debit ?? null;
  let credit = draft.credit ?? null;

  let amount = draft.amount ?? null;
  if (amount == null) {
    if (debit != null && credit == null) amount = -Math.abs(debit);
    else if (credit != null && debit == null) amount = Math.abs(credit);
    else if (debit != null && credit != null) amount = credit - debit;
  } else if (debit == null && credit == null && Number.isFinite(amount)) {
    if (amount > 0) credit = Math.abs(amount);
    else if (amount < 0) debit = Math.abs(amount);
  }

  const transaction_type = draft.transaction_type ?? "UNKNOWN";

  return TransactionSchema.parse({
    id: randomUUID(),
    transaction_date: draft.transaction_date ?? null,
    value_date: draft.value_date ?? null,
    posting_date: draft.posting_date ?? null,
    description: draft.description ?? null,
    reference: draft.reference ?? null,
    debit,
    credit,
    amount,
    balance: draft.balance ?? null,
    currency: draft.currency ?? null,
    transaction_type,
    duplicate_suspected: false,
    duplicate_group_id: null,
    confidence: null,
    confidence_factors: {},
    raw: draft.raw ?? {},
  });
}
