/**
 * Response sanitization — mask accounts, strip internals, round money.
 */

import { roundMoney } from "../money/index.js";

/** Mask account numbers for public responses (****1234). */
export function maskAccountNumber(value: string | null | undefined): string | null {
  if (value == null) return null;
  const digits = value.replace(/\s+/g, "").trim();
  if (!digits) return null;
  const alnum = digits.replace(/[^0-9A-Za-z]/g, "");
  if (alnum.length <= 4) return `****${alnum}`;
  return `****${alnum.slice(-4)}`;
}

const INTERNAL_TX_KEYS = new Set([
  "raw",
  "confidence_factors",
  "id",
]);

export function sanitizeTransactionForPublic(
  tx: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    transaction_date: tx.transaction_date ?? null,
    value_date: tx.value_date ?? null,
    posting_date: tx.posting_date ?? null,
    description: tx.description ?? null,
    reference: tx.reference ?? null,
    debit: roundMoney(tx.debit as number | null),
    credit: roundMoney(tx.credit as number | null),
    amount: roundMoney(tx.amount as number | null),
    balance: roundMoney(tx.balance as number | null),
    currency: tx.currency ?? null,
    transaction_type: tx.transaction_type ?? "UNKNOWN",
  };

  // Quality flags may remain as non-sensitive summary hints
  if (typeof tx.duplicate_suspected === "boolean") {
    out.duplicate_suspected = tx.duplicate_suspected;
  }
  if (tx.duplicate_group_id != null) {
    out.duplicate_group_id = tx.duplicate_group_id;
  }
  if (typeof tx.confidence === "number") {
    out.confidence = roundMoney(tx.confidence);
  }

  for (const key of Object.keys(out)) {
    if (INTERNAL_TX_KEYS.has(key)) delete out[key];
  }
  return out;
}

/** Strip filesystem paths and credential-bearing URLs from nested objects. */
export function stripSensitivePaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitivePaths);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (
        k === "local_path" ||
        k === "path" ||
        k === "tmp_path" ||
        k === "stack"
      ) {
        continue;
      }
      if (
        (k === "source_url" || k === "url") &&
        typeof v === "string" &&
        /@/.test(v)
      ) {
        try {
          const u = new URL(v);
          u.username = "";
          u.password = "";
          out[k] = u.toString();
          continue;
        } catch {
          out[k] = null;
          continue;
        }
      }
      out[k] = stripSensitivePaths(v);
    }
    return out;
  }
  return value;
}
