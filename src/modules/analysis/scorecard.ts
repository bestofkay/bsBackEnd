import type { ScoreFactor, StatementAnalysis } from "./types.js";

export type ScoreInput = {
  hasConfirmedSalary: boolean;
  hasRecurringIncome: boolean;
  salaryConfidence: number;
  nameScore: number;
  nameConfidence: number;
  reconciled: boolean;
  months: number;
  isGambler: boolean;
  gamblingConfidence: number;
  regularGambler: boolean;
  isBorrower: boolean;
  frequentBorrower: boolean;
  overdraftDays: number;
  zeroBalanceDays: number;
  withdrawalToDeposit: number | null;
  gambleToDeposit: number | null;
  highSweepMonths: number;
  concentratedInflow: boolean;
  isStatementRecent: boolean;
  stableIncomeMonths: number;
  repaymentCoverage: number | null;
};

function band(score: number): StatementAnalysis["score_band"] {
  if (score >= 75) return "strong";
  if (score >= 55) return "moderate";
  if (score >= 40) return "weak";
  return "high_risk";
}

/**
 * Transparent additive scorecard (0–100). Points are confidence-weighted.
 * This is underwriting *support*, not a regulated credit score.
 */
export function buildScorecard(input: ScoreInput): {
  score: number;
  score_band: StatementAnalysis["score_band"];
  factors: ScoreFactor[];
  recommendation: StatementAnalysis["decision_support"]["recommendation"];
  reason_codes: string[];
  summary: string;
} {
  const factors: ScoreFactor[] = [];
  let score = 50;

  const add = (
    code: string,
    label: string,
    points: number,
    confidence: number,
    detail: string,
  ) => {
    const weighted = Math.round(points * Math.max(0.35, Math.min(1, confidence)));
    score += weighted;
    factors.push({
      code,
      label,
      direction: weighted > 0 ? "positive" : weighted < 0 ? "negative" : "neutral",
      points: weighted,
      confidence: Math.round(confidence * 100) / 100,
      detail,
    });
  };

  if (input.hasConfirmedSalary) {
    add("CONFIRMED_SALARY", "Confirmed salary credits", 14, input.salaryConfidence, "Keyword-confirmed payroll inflows");
  } else if (input.hasRecurringIncome) {
    add(
      "RECURRING_INCOME",
      "Recurring income pattern",
      10,
      0.7,
      "Stable credit cluster across multiple months",
    );
  } else {
    add("NO_STABLE_INCOME", "No stable income detected", -10, 0.7, "No salary keywords or recurring clusters");
  }

  if (input.stableIncomeMonths >= 3) {
    add("INCOME_TENURE", "Income tenure ≥ 3 months", 6, 0.8, `${input.stableIncomeMonths} stable months`);
  }

  if (input.nameScore >= 60) {
    add(
      "NAME_MATCH_STRONG",
      "Strong name match in narrations",
      8,
      input.nameConfidence,
      `Account-name match strength ${input.nameScore}/100`,
    );
  } else if (input.nameScore >= 40) {
    add(
      "NAME_MATCH_PARTIAL",
      "Partial name match",
      4,
      input.nameConfidence,
      `Account-name match strength ${input.nameScore}/100`,
    );
  } else {
    add(
      "NAME_MATCH_WEAK",
      "Weak/no name match",
      -4,
      0.6,
      `Account-name match strength ${input.nameScore}/100`,
    );
  }

  if (input.reconciled) {
    add("RECONCILED", "Statement reconciles", 5, 0.95, "Opening + credits − debits ≈ closing");
  } else {
    add("NOT_RECONCILED", "Statement does not reconcile", -6, 0.85, "Balance integrity concern");
  }

  if (input.months >= 6) add("HISTORY_6M", "History ≥ 6 months", 6, 0.9, `${input.months} months`);
  else if (input.months >= 3) add("HISTORY_3M", "History ≥ 3 months", 3, 0.85, `${input.months} months`);
  else add("HISTORY_SHORT", "Short statement history", -5, 0.8, `${input.months} months`);

  if (input.isStatementRecent) {
    add("RECENT_STATEMENT", "Statement end is recent", 3, 0.9, "Ended within 45 days");
  } else {
    add("STALE_STATEMENT", "Statement may be stale", -4, 0.75, "Ended > 45 days ago");
  }

  if (input.regularGambler) {
    add(
      "REGULAR_GAMBLER",
      "Regular gambling activity",
      -14,
      input.gamblingConfidence,
      "Frequent/high betting stakes or winnings",
    );
  } else if (input.isGambler) {
    add(
      "GAMBLING",
      "Gambling activity",
      -8,
      input.gamblingConfidence,
      "Betting-related stakes and/or winnings present",
    );
  }

  if (input.gambleToDeposit != null && input.gambleToDeposit > 5) {
    add(
      "GAMBLE_RATIO",
      "Gambling/deposit ratio elevated",
      -6,
      0.8,
      `Betting activity is ${input.gambleToDeposit}% of total deposits`,
    );
  }

  if (input.frequentBorrower) {
    add("FREQUENT_BORROWER", "Frequent borrowing", -8, 0.8, "Multiple loan events or lenders detected");
  } else if (input.isBorrower) {
    add("BORROWER", "Loan activity present", -3, 0.7, "At least one loan-related credit or debit");
  }

  if (input.repaymentCoverage != null) {
    const covPct = Math.round(input.repaymentCoverage * 100);
    if (input.repaymentCoverage >= 0.9) {
      add(
        "LOAN_COVERAGE_GOOD",
        "Loan repayments cover disbursements",
        4,
        0.75,
        `Repayments equal ${covPct}% of amounts disbursed`,
      );
    } else if (input.repaymentCoverage < 0.5 && input.isBorrower) {
      add(
        "LOAN_COVERAGE_LOW",
        "Low loan repayment coverage",
        -5,
        0.7,
        `Only ${covPct}% of disbursed loans appear repaid in this statement`,
      );
    }
  }

  if (input.overdraftDays > 10) {
    add(
      "OVERDRAFT_HEAVY",
      "Frequent overdraft",
      -10,
      0.9,
      `Balance went negative on ${input.overdraftDays} calendar days`,
    );
  } else if (input.overdraftDays > 0) {
    add(
      "OVERDRAFT",
      "Overdraft observed",
      -5,
      0.85,
      `Balance went negative on ${input.overdraftDays} calendar day${input.overdraftDays === 1 ? "" : "s"}`,
    );
  }

  if (input.zeroBalanceDays > 15) {
    add(
      "ZERO_BALANCE_HEAVY",
      "Many zero-balance days",
      -8,
      0.85,
      `${input.zeroBalanceDays} days at or near zero balance`,
    );
  } else if (input.zeroBalanceDays > 5) {
    add(
      "ZERO_BALANCE",
      "Several zero-balance days",
      -4,
      0.8,
      `${input.zeroBalanceDays} days at or near zero balance`,
    );
  }

  if (input.withdrawalToDeposit != null) {
    if (input.withdrawalToDeposit > 120) {
      add(
        "HIGH_WDR_RATIO",
        "Withdrawals much higher than deposits",
        -8,
        0.85,
        `Withdrawals are ${input.withdrawalToDeposit}% of deposits`,
      );
    } else if (input.withdrawalToDeposit < 90) {
      add(
        "HEALTHY_WDR_RATIO",
        "Withdrawals below deposits",
        4,
        0.8,
        `Withdrawals are ${input.withdrawalToDeposit}% of deposits`,
      );
    }
  }

  if (input.highSweepMonths >= 3) {
    add(
      "DEPOSIT_SWEEP",
      "Deposits often spent the same month",
      -6,
      0.75,
      `${input.highSweepMonths} months where ≥90% of deposits left as withdrawals`,
    );
  }

  if (input.concentratedInflow) {
    add("CONCENTRATED_INFLOW", "Inflows highly concentrated", -5, 0.7, "Large share of credits in short window");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const score_band = band(score);

  const reason_codes = factors
    .filter((f) => f.direction === "negative" || f.code.startsWith("NO_") || f.code.includes("STALE"))
    .map((f) => f.code);

  let recommendation: StatementAnalysis["decision_support"]["recommendation"] = "review";
  if (score >= 70 && !input.regularGambler && input.reconciled) recommendation = "proceed";
  else if (score < 40 || input.regularGambler || (!input.reconciled && input.months >= 3)) {
    recommendation = "decline_support";
  }

  const summary =
    recommendation === "proceed"
      ? "Analytics support proceeding with standard review."
      : recommendation === "decline_support"
        ? "Analytics suggest elevated risk; decline or escalate."
        : "Analytics are mixed; manual underwriting review recommended.";

  return { score, score_band, factors, recommendation, reason_codes, summary };
}
