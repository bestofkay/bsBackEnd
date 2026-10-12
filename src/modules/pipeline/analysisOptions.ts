import type { Statement, Transaction } from "../../contracts/index.js";

export type AnalysisRequestOptions = {
  /** Optional display / search name for the statement owner */
  ownerName?: string | null;
  /** Inclusive analysis window start (YYYY-MM-DD) */
  periodStart?: string | null;
  /** Inclusive analysis window end (YYYY-MM-DD) */
  periodEnd?: string | null;
};

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) return null;
  return trimmed;
}

export function normalizeAnalysisOptions(
  raw: AnalysisRequestOptions | null | undefined,
): Required<AnalysisRequestOptions> {
  let periodStart = normalizeDate(raw?.periodStart ?? null);
  let periodEnd = normalizeDate(raw?.periodEnd ?? null);
  if (periodStart && periodEnd && periodStart > periodEnd) {
    const tmp = periodStart;
    periodStart = periodEnd;
    periodEnd = tmp;
  }
  const owner = raw?.ownerName?.trim();
  return {
    ownerName: owner ? owner.slice(0, 200) : null,
    periodStart,
    periodEnd,
  };
}

export function transactionDateKey(tx: Transaction): string | null {
  const d = tx.transaction_date || tx.value_date || tx.posting_date || null;
  if (!d) return null;
  return d.slice(0, 10);
}

export function filterTransactionsByPeriod(
  transactions: Transaction[],
  periodStart: string | null,
  periodEnd: string | null,
): { scoped: Transaction[]; fullCount: number; scopedCount: number } {
  const fullCount = transactions.length;
  if (!periodStart && !periodEnd) {
    return { scoped: transactions, fullCount, scopedCount: fullCount };
  }
  const scoped = transactions.filter((tx) => {
    const key = transactionDateKey(tx);
    if (!key) return false;
    if (periodStart && key < periodStart) return false;
    if (periodEnd && key > periodEnd) return false;
    return true;
  });
  return { scoped, fullCount, scopedCount: scoped.length };
}

export function applyOwnerNameToStatement(
  statement: Statement,
  ownerName: string | null,
): Statement {
  if (!ownerName) return statement;
  return {
    ...statement,
    account: {
      ...(statement.account ?? {}),
      account_name: ownerName,
    },
  };
}
