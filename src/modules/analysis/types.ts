import type { AnalysisCategory } from "./patterns.js";

/** Evidence-backed analytic signal — never a bare boolean without confidence. */
export type AnalysisSignal<T = boolean> = {
  code: string;
  value: T;
  /** 0–1 model confidence in this signal */
  confidence: number;
  evidence: string[];
};

export type CategoryBucket = {
  category: AnalysisCategory;
  count: number;
  debit_total: number;
  credit_total: number;
};

export type MonthlyBucket = {
  month: string;
  credit_total: number;
  debit_total: number;
  credit_count: number;
  debit_count: number;
  net: number;
  average_balance: number | null;
  salary_total: number;
  loan_disbursed: number;
  loan_repaid: number;
  gambling_total: number;
  max_single_deposit: number;
  deposit_sweep_ratio: number | null;
};

export type PartyStat = {
  name: string;
  count: number;
  total: number;
};

export type IncomeCluster = {
  amount: number;
  count: number;
  months: string[];
  day_of_month_mode: number | null;
  total: number;
  confidence: number;
  label: "confirmed_salary" | "suspected_recurring_income" | "benefit";
};

export type LoanEvent = {
  date: string | null;
  amount: number;
  side: "disbursement" | "repayment";
  lender: string | null;
  description: string | null;
  confidence: number;
};

/** Week-of-month cell (PHP credit_mweek / salary_mweek / loan_dmweek). Week 5 merges into 4. */
export type WeekOfMonthCell = {
  month: string;
  week: 1 | 2 | 3 | 4;
  deposit: number;
  withdrawal: number;
  salary: number;
  benefit: number;
  loan_disbursed: number;
  loan_repaid: number;
};

/** Calendar weekday totals (0 = Sunday … 6 = Saturday). */
export type WeekdayBucket = {
  weekday: number;
  label: string;
  credit_total: number;
  debit_total: number;
  credit_count: number;
  debit_count: number;
};

/** Day-of-month inflow/outflow totals (1–31) for payday detection. */
export type DayOfMonthBucket = {
  day: number;
  credit_total: number;
  debit_total: number;
  credit_count: number;
  debit_count: number;
};

/** Dual-side loan timing bucket (disbursement vs repayment). */
export type LoanTimingBucket = {
  key: string;
  label: string;
  disbursed: number;
  repaid: number;
  disbursed_count: number;
  repaid_count: number;
};

/** PHP loan_dmweek + day/week patterns for when loans are taken vs repaid. */
export type LoanTimingAnalytics = {
  /** Per-month × week 1–4 matrix (amount=repaid, credit=disbursed in PHP). */
  week_of_month: WeekOfMonthCell[];
  week_of_month_totals: Array<{
    week: 1 | 2 | 3 | 4;
    disbursed: number;
    repaid: number;
  }>;
  by_weekday: LoanTimingBucket[];
  by_day_of_month: LoanTimingBucket[];
  peak_disbursement_weekday: string | null;
  peak_repayment_weekday: string | null;
  peak_disbursement_week_of_month: number | null;
  peak_repayment_week_of_month: number | null;
  peak_disbursement_day_of_month: number | null;
  peak_repayment_day_of_month: number | null;
};

export type TimingAnalytics = {
  /** PHP-style per-month × week 1–4 deposit/withdrawal matrix. */
  week_of_month: WeekOfMonthCell[];
  /** Aggregated across all months: total credits/debits by week-of-month. */
  week_of_month_totals: Array<{
    week: 1 | 2 | 3 | 4;
    deposit: number;
    withdrawal: number;
    salary: number;
    benefit: number;
    loan_disbursed: number;
    loan_repaid: number;
  }>;
  by_weekday: WeekdayBucket[];
  by_day_of_month: DayOfMonthBucket[];
  peak_inflow_weekday: string | null;
  peak_inflow_week_of_month: number | null;
  peak_inflow_day_of_month: number | null;
  /** When loan disbursements and repayments occur (PHP loan_dmweek / loan_week). */
  loans: LoanTimingAnalytics;
};

export type ScoreFactor = {
  code: string;
  label: string;
  direction: "positive" | "negative" | "neutral";
  points: number;
  confidence: number;
  detail: string;
};

export type StatementAnalysis = {
  meta: {
    version: string;
    generated_at: string;
    methodology: string;
    limitations: string[];
  };
  /** Calibrated 0–100 underwriting-support score (not a credit bureau score). */
  score: number;
  score_band: "strong" | "moderate" | "weak" | "high_risk";
  score_factors: ScoreFactor[];
  decision_support: {
    recommendation: "proceed" | "review" | "decline_support";
    reason_codes: string[];
    summary: string;
  };
  period: {
    from: string | null;
    to: string | null;
    days: number;
    months: number;
  };
  totals: {
    transaction_count: number;
    total_deposit: number;
    total_withdrawal: number;
    net_deposit: number;
    net_withdrawal: number;
    reversal_credit_total: number;
    reversal_count: number;
    average_daily_balance: number | null;
    average_daily_deposit: number | null;
    average_daily_withdrawal: number | null;
    average_monthly_deposit: number | null;
    average_monthly_withdrawal: number | null;
    withdrawal_to_deposit_ratio: number | null;
    gamble_to_deposit_ratio: number | null;
    credit_turnover: number | null;
    opening_balance: number | null;
    closing_balance: number | null;
    current_balance: number | null;
    /** Approximate affordability proxy: avg monthly net / requested (if provided). */
    estimated_dti: number | null;
  };
  signals: AnalysisSignal[];
  flags: {
    is_borrower: boolean;
    frequent_borrower: boolean;
    is_gambler: boolean;
    regular_gambler: boolean;
    is_religion: boolean;
    is_clubbing: boolean;
    is_overdraft: boolean;
    has_salary: boolean;
    has_recurring_income: boolean;
    is_statement_recent: boolean;
  };
  income: {
    total_salary: number;
    average_salary: number | null;
    salary_count: number;
    confirmed_salary_confidence: number;
    suspected_salary_total: number;
    suspected_recurring_total: number;
    benefit_total: number;
    other_income: number;
    clusters: IncomeCluster[];
    stable_income_months: number;
  };
  loans: {
    total_disbursed: number;
    total_repaid: number;
    net_debt: number;
    loan_count: number;
    lenders: string[];
    last_loan_amount: number | null;
    last_loan_date: string | null;
    events: LoanEvent[];
    repayment_coverage: number | null;
  };
  spend: {
    total_atm: number;
    total_pos: number;
    /** Gambling outflows (stakes / deposits to betting brands). */
    total_gambling: number;
    /** Gambling inflows (winnings / cashouts from betting brands). */
    total_gambling_inflow: number;
    total_entertainment: number;
    total_religion: number;
    total_airtime: number;
    total_bank_charges: number;
    total_utility: number;
    total_investment: number;
  };
  behavior: {
    average_deposit_sweep: number | null;
    high_sweep_months: number;
    spike: {
      one_day_pct_of_credits: number | null;
      three_day_pct_of_credits: number | null;
      thirty_day_pct_of_credits: number | null;
      concentrated_inflow: boolean;
    };
    balance_persistence: {
      days_above_20pct_avg_deposit: number;
      days_above_50pct_avg_deposit: number;
    };
  };
  cashflow: {
    monthly: MonthlyBucket[];
    average_monthly_net: number | null;
    lowest_balance: number | null;
    highest_balance: number | null;
    zero_balance_days: number;
    overdraft_days: number;
    highest_overdraft: number | null;
  };
  activity: {
    deposit_days: number;
    withdrawal_days: number;
    transaction_days: number;
    monthly_deposit_activity_pct: number | null;
    monthly_withdrawal_activity_pct: number | null;
  };
  /** Day / week-of-month inflow timing (mirrored from PHP Analyses credit_mweek). */
  timing: TimingAnalytics;
  counterparties: {
    top_recipients: PartyStat[];
    top_senders: PartyStat[];
    recipient_count: number;
    sender_count: number;
  };
  categories: CategoryBucket[];
  deposit_size_bands: Record<string, number>;
  name_check: AnalysisSignal<boolean> & {
    account_name: string | null;
    score: number;
    message: string;
  };
  risks: AnalysisSignal<string>[];
};
