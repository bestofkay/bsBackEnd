import type { Statement, Transaction } from "../../contracts/index.js";
import { analyzeStatement, type StatementAnalysis } from "./analyze.js";

/** True when stored analysis predates day/week + loan timing fields. */
export function needsAnalysisRefresh(analysis: unknown): boolean {
  if (!analysis || typeof analysis !== "object") return true;
  const a = analysis as Record<string, unknown>;
  const timing = a.timing as Record<string, unknown> | undefined;
  if (!timing || typeof timing !== "object") return true;
  const loans = timing.loans as Record<string, unknown> | undefined;
  if (!loans || typeof loans !== "object") return true;
  if (!Array.isArray(loans.by_weekday) || loans.by_weekday.length !== 7) return true;
  if (!Array.isArray(timing.by_weekday) || timing.by_weekday.length !== 7) return true;
  if (!Array.isArray(timing.week_of_month)) return true;
  return false;
}

function statementFromPublic(payload: Record<string, unknown>, fallbackId: string): Statement {
  const statementPub = (payload.statement ?? {}) as Record<string, unknown>;
  const period = (statementPub.statement_period ?? {}) as {
    from?: string | null;
    to?: string | null;
  };
  return {
    id: typeof payload.statement_id === "string" ? payload.statement_id : fallbackId,
    account: {
      account_name: (statementPub.account_name as string) ?? null,
      account_number: (statementPub.account_number as string) ?? null,
      bank_name: (statementPub.bank_name as string) ?? null,
      bank_code: null,
      currency: (statementPub.currency as string) ?? "NGN",
      account_type: (statementPub.account_type as string) ?? null,
      branch: null,
      iban: null,
      sort_code: null,
    },
    statement_period_start: period.from ?? null,
    statement_period_end: period.to ?? null,
    opening_balance: (statementPub.opening_balance as number) ?? null,
    closing_balance: (statementPub.closing_balance as number) ?? null,
    currency: (statementPub.currency as string) ?? "NGN",
    bank_name: (statementPub.bank_name as string) ?? null,
    statement_number: null,
    page_count: null,
    extracted_at: null,
  };
}

/** Rebuild analysis from a stored public result (transactions + statement). */
export function rebuildAnalysisFromPayload(
  payload: Record<string, unknown>,
): StatementAnalysis | null {
  const transactions = (
    Array.isArray(payload.transactions) ? payload.transactions : []
  ) as Transaction[];
  if (!transactions.length) return null;
  const statement = statementFromPublic(
    payload,
    typeof payload.statement_id === "string" ? payload.statement_id : "stmt_refresh",
  );
  const reconciled =
    (payload.validation as { reconciled?: boolean } | undefined)?.reconciled === true;
  return analyzeStatement({ statement, transactions, reconciled });
}

/**
 * Ensure payload.analysis includes current timing fields.
 * Returns a new object when refreshed; otherwise the original payload.
 */
export function ensureFreshAnalysis(
  payload: Record<string, unknown>,
): { payload: Record<string, unknown>; refreshed: boolean; analysis: StatementAnalysis | null } {
  const existing = payload.analysis;
  if (!needsAnalysisRefresh(existing)) {
    return {
      payload,
      refreshed: false,
      analysis: existing as StatementAnalysis,
    };
  }
  const analysis = rebuildAnalysisFromPayload(payload);
  if (!analysis) {
    return { payload, refreshed: false, analysis: null };
  }
  return {
    payload: { ...payload, analysis: analysis as unknown as Record<string, unknown> },
    refreshed: true,
    analysis,
  };
}
