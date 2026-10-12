/**
 * Explainable transaction confidence engine (Group 5).
 * Scores are review-prioritization indicators — not correctness guarantees.
 */

import {
  QualitySummarySchema,
  type QualitySummary,
  type Transaction,
  type ValidationResult,
  type ExtractionWarning,
} from "../../contracts/index.js";

export type ConfidenceBreakdown = {
  date: number;
  amount: number;
  debit_credit: number;
  balance: number;
  description: number;
  reference: number;
  row_structure: number;
  ocr_parser: number;
  validation: number;
};

export type ScoredTransaction = {
  index: number;
  confidence: number;
  factors: ConfidenceBreakdown;
  requires_review: boolean;
};

const WEIGHTS: ConfidenceBreakdown = {
  date: 0.15,
  amount: 0.2,
  debit_credit: 0.2,
  balance: 0.1,
  description: 0.1,
  reference: 0.05,
  row_structure: 0.05,
  ocr_parser: 0.05,
  validation: 0.1,
};

const REVIEW_THRESHOLD = 0.75;

function present(value: unknown): boolean {
  return value != null && !(typeof value === "string" && value.trim() === "");
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function scoreDate(tx: Transaction): number {
  if (present(tx.transaction_date)) return 1;
  if (present(tx.value_date) || present(tx.posting_date)) return 0.7;
  return 0;
}

function scoreAmount(tx: Transaction): number {
  if (tx.amount != null || tx.debit != null || tx.credit != null) return 1;
  return 0;
}

function scoreDebitCredit(tx: Transaction): number {
  const hasDebit = tx.debit != null && tx.debit !== 0;
  const hasCredit = tx.credit != null && tx.credit !== 0;
  if (hasDebit && hasCredit) return 0.4;
  if (hasDebit || hasCredit) return 1;
  if (tx.amount != null) return 0.7;
  return 0;
}

function scoreBalance(tx: Transaction): number {
  return tx.balance != null ? 1 : 0;
}

function scoreDescription(tx: Transaction): number {
  if (!present(tx.description)) return 0;
  const len = tx.description!.trim().length;
  if (len >= 8) return 1;
  if (len >= 3) return 0.6;
  return 0.3;
}

function scoreReference(tx: Transaction): number {
  return present(tx.reference) ? 1 : 0;
}

function scoreRowStructure(tx: Transaction): number {
  // Prefer rows that look complete: date + money + description
  let score = 0;
  if (scoreDate(tx) > 0) score += 0.4;
  if (scoreAmount(tx) > 0) score += 0.4;
  if (scoreDescription(tx) > 0) score += 0.2;
  return clamp01(score);
}

function scoreOcrParser(tx: Transaction): number {
  const raw = tx.raw ?? {};
  const ocr = raw.ocr_confidence;
  if (typeof ocr === "number" && Number.isFinite(ocr)) return clamp01(ocr);
  const parser = raw.parser_confidence;
  if (typeof parser === "number" && Number.isFinite(parser)) return clamp01(parser);
  // Native structured extracts default mid-high
  return 0.85;
}

function scoreValidationForIndex(
  index: number,
  validation: ValidationResult | null | undefined,
): number {
  if (!validation) return 0.8;
  const issues = validation.issues.filter((i) => i.transaction_index === index);
  if (issues.some((i) => i.severity === "error")) return 0.2;
  if (issues.some((i) => i.severity === "warning")) return 0.55;
  if (issues.some((i) => i.severity === "info")) return 0.85;
  return 1;
}

export function scoreTransactionConfidenceDetailed(
  tx: Transaction,
  index: number,
  validation?: ValidationResult | null,
): { confidence: number; factors: ConfidenceBreakdown } {
  const factors: ConfidenceBreakdown = {
    date: scoreDate(tx),
    amount: scoreAmount(tx),
    debit_credit: scoreDebitCredit(tx),
    balance: scoreBalance(tx),
    description: scoreDescription(tx),
    reference: scoreReference(tx),
    row_structure: scoreRowStructure(tx),
    ocr_parser: scoreOcrParser(tx),
    validation: scoreValidationForIndex(index, validation),
  };

  let total = 0;
  for (const key of Object.keys(WEIGHTS) as Array<keyof ConfidenceBreakdown>) {
    total += factors[key] * WEIGHTS[key];
  }
  return { confidence: Number(clamp01(total).toFixed(4)), factors };
}

/** Simple presence-based score kept for backward compatibility. */
export function scoreTransactionConfidence(tx: Transaction): number {
  return scoreTransactionConfidenceDetailed(tx, -1, null).confidence;
}

export function scoreAllTransactions(
  transactions: Transaction[],
  validation?: ValidationResult | null,
): ScoredTransaction[] {
  return transactions.map((tx, index) => {
    const { confidence, factors } = scoreTransactionConfidenceDetailed(tx, index, validation);
    return {
      index,
      confidence,
      factors,
      requires_review: confidence < REVIEW_THRESHOLD,
    };
  });
}

export function applyConfidenceScores(
  transactions: Transaction[],
  scored: ScoredTransaction[],
): Transaction[] {
  return transactions.map((tx, index) => {
    const s = scored[index];
    return {
      ...tx,
      confidence: s?.confidence ?? null,
      confidence_factors: s?.factors ?? {},
    };
  });
}

export function buildQualitySummary(params: {
  transactions: Transaction[];
  validation: ValidationResult;
  duplicateCount: number;
  scored?: ScoredTransaction[];
  extraWarnings?: Array<{
    code: string;
    message: string;
    transaction_index?: number | null;
    details?: Record<string, unknown>;
  }>;
}): QualitySummary {
  const scored =
    params.scored ?? scoreAllTransactions(params.transactions, params.validation);

  const overall =
    scored.length === 0
      ? null
      : Number(
          (scored.reduce((a, b) => a + b.confidence, 0) / scored.length).toFixed(4),
        );

  const reviewCount = scored.filter((s) => s.requires_review).length;

  const warnings = [
    ...(params.extraWarnings ?? []).map((w) => ({
      code: w.code,
      message: w.message,
      transaction_index: w.transaction_index ?? null,
      details: w.details ?? {},
    })),
  ];

  for (const s of scored) {
    if (s.requires_review) {
      warnings.push({
        code: "LOW_CONFIDENCE_TRANSACTION",
        message: `Transaction ${s.index} confidence ${s.confidence} is below review threshold`,
        transaction_index: s.index,
        details: { confidence: s.confidence, factors: s.factors },
      });
    }
  }

  return QualitySummarySchema.parse({
    confidence: overall,
    overall_confidence: overall,
    field_confidence: {
      dates: averageFactor(scored, "date"),
      amounts: averageFactor(scored, "amount"),
      debit_credit: averageFactor(scored, "debit_credit"),
      descriptions: averageFactor(scored, "description"),
      references: averageFactor(scored, "reference"),
      balances: averageFactor(scored, "balance"),
    },
    transactions_requiring_review: reviewCount,
    warnings_count:
      params.validation.issues.filter((i) => i.severity === "warning").length +
      warnings.filter((w) => w.code !== "LOW_CONFIDENCE_TRANSACTION").length +
      reviewCount,
    errors_count: params.validation.issues.filter((i) => i.severity === "error").length,
    duplicate_candidates: params.duplicateCount,
    warnings,
  });
}

function averageFactor(
  scored: ScoredTransaction[],
  key: keyof ConfidenceBreakdown,
): number {
  if (scored.length === 0) return 0;
  const sum = scored.reduce((a, s) => a + s.factors[key], 0);
  return Number((sum / scored.length).toFixed(4));
}

export type { ExtractionWarning };
