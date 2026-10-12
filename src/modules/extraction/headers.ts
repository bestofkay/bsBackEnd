/**
 * Flexible bank-statement header detection and canonical field mapping.
 */

import type { CanonicalField } from "./types.js";

const HEADER_ALIASES: Record<Exclude<CanonicalField, "unknown">, string[]> = {
  value_date: ["value date", "val date", "valeur"],
  posting_date: ["posting date", "posted date", "post date"],
  transaction_date: [
    "transaction date",
    "txn date",
    "tran date",
    "trans date",
    "booking date",
    "date",
  ],
  description: [
    "description",
    "narration",
    "details",
    "particulars",
    "transaction details",
    "memo",
    "remarks",
  ],
  reference: [
    "reference",
    "ref no",
    "ref.",
    "cheque no",
    "check no",
    "transaction id",
    "txn id",
    "ref",
  ],
  debit: ["debit", "withdrawal", "withdrawals", "money out", "paid out", "dr"],
  credit: ["credit", "deposit", "deposits", "money in", "paid in", "cr"],
  amount: ["txn amount", "transaction amount", "amount", "value"],
  balance: ["running balance", "closing balance", "available balance", "balance", "bal"],
};

function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_/|]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function mapHeaderToField(raw: string): CanonicalField {
  const normalized = normalizeHeader(raw);
  if (!normalized) return "unknown";

  // Exact match first (longest fields are already specific phrases).
  let best: { field: CanonicalField; score: number } | null = null;

  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as Array<
    [Exclude<CanonicalField, "unknown">, string[]]
  >) {
    for (const alias of aliases) {
      if (normalized === alias) {
        // Exact wins immediately for this field; prefer longer aliases globally.
        const score = 1000 + alias.length;
        if (!best || score > best.score) best = { field, score };
      } else if (normalized.includes(alias)) {
        const score = alias.length;
        if (!best || score > best.score) best = { field, score };
      }
    }
  }

  return best?.field ?? "unknown";
}

export function scoreHeaderRow(cells: string[]): number {
  const mapped = cells.map(mapHeaderToField);
  const known = mapped.filter((f) => f !== "unknown").length;
  const hasDate = mapped.some(
    (f) => f === "transaction_date" || f === "value_date" || f === "posting_date",
  );
  const hasDesc = mapped.includes("description");
  const hasMoney = mapped.some(
    (f) => f === "debit" || f === "credit" || f === "amount" || f === "balance",
  );
  let score = known;
  if (hasDate) score += 2;
  if (hasDesc) score += 2;
  if (hasMoney) score += 2;
  return score;
}

export function detectHeaderRow(rows: string[][]): {
  index: number;
  mapping: Array<{ column: number; raw_text: string; mapped_field: CanonicalField }>;
} | null {
  let bestIndex = -1;
  let bestScore = 0;
  let bestMapping: Array<{ column: number; raw_text: string; mapped_field: CanonicalField }> = [];

  const limit = Math.min(rows.length, 30);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i].map((c) => String(c ?? "").trim());
    if (cells.every((c) => c.length === 0)) continue;
    const score = scoreHeaderRow(cells);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
      bestMapping = cells.map((raw_text, column) => ({
        column,
        raw_text,
        mapped_field: mapHeaderToField(raw_text),
      }));
    }
  }

  // Require a plausible header signal.
  if (bestIndex < 0 || bestScore < 4) return null;
  return { index: bestIndex, mapping: bestMapping };
}

export function isLikelySummaryRow(cells: string[]): boolean {
  const joined = cells.join(" ").toLowerCase();
  return (
    /\b(total|totals|opening balance|closing balance|brought forward|carried forward|summary)\b/.test(
      joined,
    ) && !/\b(date|description|narration)\b/.test(joined)
  );
}

export function isLikelyFooterRow(cells: string[]): boolean {
  const joined = cells.join(" ").toLowerCase();
  return /\b(page \d+|continued|end of statement|confidential|www\.|customer service)\b/.test(
    joined,
  );
}
