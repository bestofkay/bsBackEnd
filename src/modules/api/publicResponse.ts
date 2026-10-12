/**
 * Map internal ExtractionResult → sanitized public API response.
 * Validates against the formal JSON Schema before return.
 */

import type {
  ExtractionResult,
  ReconciliationResult,
  Statement,
  Transaction,
} from "../../contracts/index.js";
import { roundMoney } from "../money/index.js";
import { maskAccountNumber, sanitizeTransactionForPublic, stripSensitivePaths } from "./sanitize.js";
import { validatePublicExtractionResponse } from "../schema/validate.js";
import { publicErrorResponse } from "./errors.js";
import type { ErrorResponse } from "../../contracts/index.js";

export type PublicExtractionResponse = {
  success: true;
  statement: {
    id: string | null;
    bank_name: string | null;
    account_name: string | null;
    account_number: string | null;
    account_type: string | null;
    currency: string | null;
    statement_period: { from: string | null; to: string | null };
    opening_balance: number | null;
    closing_balance: number | null;
  };
  transactions: Array<Record<string, unknown>>;
  summary: {
    transaction_count: number;
    total_debits: number | null;
    total_credits: number | null;
    debit_total: number | null;
    credit_total: number | null;
    currency: string | null;
    period_start: string | null;
    period_end: string | null;
  };
  validation: {
    reconciled: boolean;
    calculated_closing_balance: number | null;
    statement_closing_balance: number | null;
    difference: number | null;
    reconciliation_status: string;
    is_valid: boolean;
    issues: unknown[];
  };
  quality: {
    confidence: number | null;
    transactions_requiring_review: number;
    warnings: Array<{
      code: string;
      message: string;
      transaction_index?: number | null;
      details?: Record<string, unknown>;
    }>;
  };
  analysis?: Record<string, unknown> | null;
  reconciliation?: ReconciliationResult;
  warnings?: unknown[];
  run_id?: string | null;
  statement_id?: string | null;
  idempotent_replay?: boolean;
  reference_id?: string | null;
  owner_name?: string | null;
  analysis_period?: { from: string | null; to: string | null };
};

function sanitizeWarningDetails(
  details: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!details || typeof details !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (key === "path" || key === "local_path" || key === "stack") continue;
    if (typeof value === "string" && /([A-Za-z]:\\|\/tmp\/|\/uploads\/)/.test(value)) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value == null
    ) {
      out[key] = value;
    }
  }
  return out;
}

function accountFromStatement(statement: Statement) {
  const account = statement.account ?? {};
  return {
    bank_name: statement.bank_name ?? account.bank_name ?? null,
    account_name: account.account_name ?? null,
    account_number: maskAccountNumber(account.account_number ?? null),
    account_type: account.account_type ?? null,
    currency: statement.currency ?? account.currency ?? null,
  };
}

export function toPublicExtractionResponse(
  result: ExtractionResult,
  options: {
    statementId?: string | null;
    idempotentReplay?: boolean;
  } = {},
): PublicExtractionResponse | ErrorResponse {
  const acct = accountFromStatement(result.statement);
  const recon = result.reconciliation;

  const transactions = result.transactions.map((tx: Transaction) =>
    sanitizeTransactionForPublic(tx as unknown as Record<string, unknown>),
  );

  const debitTotal = roundMoney(result.summary.debit_total);
  const creditTotal = roundMoney(result.summary.credit_total);

  const publicBody: PublicExtractionResponse = {
    success: true,
    statement: {
      id: options.statementId ?? result.statement.id ?? null,
      bank_name: acct.bank_name,
      account_name: acct.account_name,
      account_number: acct.account_number,
      account_type: acct.account_type,
      currency: acct.currency,
      statement_period: {
        from: result.statement.statement_period_start ?? null,
        to: result.statement.statement_period_end ?? null,
      },
      opening_balance: roundMoney(result.statement.opening_balance ?? null),
      closing_balance: roundMoney(result.statement.closing_balance ?? null),
    },
    transactions,
    summary: {
      transaction_count: result.summary.transaction_count,
      total_debits: debitTotal,
      total_credits: creditTotal,
      debit_total: debitTotal,
      credit_total: creditTotal,
      currency: result.summary.currency ?? acct.currency,
      period_start: result.summary.period_start ?? null,
      period_end: result.summary.period_end ?? null,
    },
    validation: {
      reconciled: recon?.reconciled ?? recon?.is_reconciled ?? false,
      calculated_closing_balance: roundMoney(
        recon?.calculated_closing_balance ?? recon?.computed_closing_balance ?? null,
      ),
      statement_closing_balance: roundMoney(
        recon?.statement_closing_balance ?? recon?.closing_balance ?? null,
      ),
      difference: roundMoney(recon?.difference ?? null),
      reconciliation_status:
        recon?.reconciliation_status ??
        (recon?.is_reconciled ? "RECONCILED" : "NOT_DETERMINABLE"),
      is_valid: result.validation.is_valid,
      issues: result.validation.issues ?? [],
    },
    quality: {
      confidence: result.quality.confidence ?? result.quality.overall_confidence ?? null,
      transactions_requiring_review: result.quality.transactions_requiring_review ?? 0,
      warnings: (result.quality.warnings ?? []).map((w) => ({
        code: w.code,
        message: w.message,
        transaction_index: w.transaction_index ?? null,
        details: sanitizeWarningDetails(w.details),
      })),
    },
    analysis: (result.analysis as Record<string, unknown> | null | undefined) ?? null,
    run_id: result.run_id ?? null,
    statement_id: options.statementId ?? result.statement.id ?? null,
  };

  if (options.idempotentReplay) {
    publicBody.idempotent_replay = true;
  }

  const sanitized = stripSensitivePaths(publicBody) as PublicExtractionResponse;
  const validated = validatePublicExtractionResponse<PublicExtractionResponse>(sanitized);
  if (!validated.ok) {
    return publicErrorResponse(
      "VALIDATION_FAILED",
      "Extraction result failed public JSON Schema validation",
      { issues: validated.errors },
    );
  }
  return validated.value;
}
