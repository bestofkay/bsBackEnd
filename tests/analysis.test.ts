import { describe, expect, it } from "vitest";
import {
  analyzeStatement,
  classifyDescription,
  classifyNarration,
  detectIncomeClusters,
  ensureFreshAnalysis,
  needsAnalysisRefresh,
} from "../src/modules/analysis/index.js";
import { buildCanonicalTransaction } from "../src/modules/transactions/index.js";
import type { Statement, Transaction } from "../src/contracts/index.js";

function tx(partial: Parameters<typeof buildCanonicalTransaction>[0]): Transaction {
  return buildCanonicalTransaction(partial);
}

const baseStatement: Statement = {
  id: "stmt_test",
  account: {
    account_name: "SAMUEL CHIDI UDEGBUNAM",
    account_number: "0020044889",
    bank_name: "Access Bank",
    bank_code: null,
    currency: "NGN",
    account_type: "DIAMONDXTRA",
    branch: null,
    iban: null,
    sort_code: null,
  },
  statement_period_start: "2026-01-01",
  statement_period_end: "2026-06-30",
  opening_balance: 100_000,
  closing_balance: 150_000,
  currency: "NGN",
  bank_name: "Access Bank",
  statement_number: null,
  page_count: 10,
  extracted_at: null,
};

describe("analysis classifiers", () => {
  it("returns confidence with classification", () => {
    const sal = classifyNarration("SALARY SEPTEMBER 2026");
    expect(sal.category).toBe("salary");
    expect(sal.confidence).toBeGreaterThan(0.8);

    expect(classifyDescription("FairMoney loan disbursement")).toBe("loan");
    expect(classifyDescription("BET9JA STAKE")).toBe("gambling");
    expect(classifyDescription("Paystack/Transfer from Bet9jaBet9ja")).toBe("gambling");
    expect(classifyDescription("Reversal of-MOBILE TRF TO FID")).toBe("reversal");
  });

  it("does not mark ordinary names containing 'bet' as gambling", () => {
    expect(classifyDescription("MOBILE TRF TO PAY/ /OLUWASHAYO ELIZABETH EGBELEKE")).not.toBe(
      "gambling",
    );
    expect(classifyNarration("Transfer to Elizabeth Okonkwo").category).not.toBe("gambling");
  });
});

describe("recurring income clusters", () => {
  it("detects stable monthly credits without salary keyword", () => {
    const transactions = [
      tx({
        transaction_date: "2026-01-25",
        description: "NIP ACME CORP MONTHLY INFLOW",
        credit: 450_000,
        amount: 450_000,
        balance: 550_000,
      }),
      tx({
        transaction_date: "2026-02-25",
        description: "NIP ACME CORP MONTHLY INFLOW",
        credit: 450_000,
        amount: 450_000,
        balance: 600_000,
      }),
      tx({
        transaction_date: "2026-03-26",
        description: "NIP ACME CORP MONTHLY INFLOW",
        credit: 448_000,
        amount: 448_000,
        balance: 650_000,
      }),
    ];
    const clusters = detectIncomeClusters(transactions);
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters[0].label).toBe("suspected_recurring_income");
    expect(clusters[0].months.length).toBe(3);
    expect(clusters[0].confidence).toBeGreaterThan(0.55);
  });
});

describe("analyzeStatement production profile", () => {
  it("emits scorecard, signals, behavior and decision support", () => {
    const transactions = [
      tx({
        transaction_date: "2026-01-28",
        description: "SALARY JANUARY 2026 SAMUEL CHIDI",
        credit: 500_000,
        amount: 500_000,
        balance: 600_000,
      }),
      tx({
        transaction_date: "2026-02-28",
        description: "SALARY FEBRUARY 2026",
        credit: 500_000,
        amount: 500_000,
        balance: 700_000,
      }),
      tx({
        transaction_date: "2026-03-28",
        description: "SALARY MARCH 2026",
        credit: 500_000,
        amount: 500_000,
        balance: 800_000,
      }),
      tx({
        transaction_date: "2026-03-29",
        description: "MOBILE TRF TO GTB/ /JOHN DOE",
        debit: 20_000,
        amount: -20_000,
        balance: 780_000,
      }),
      tx({
        transaction_date: "2026-04-01",
        description: "BET9JA WALLET FUNDING",
        debit: 5_000,
        amount: -5_000,
        balance: 775_000,
      }),
      tx({
        transaction_date: "2026-04-05",
        description: "FairMoney LOAN DISBURSEMENT",
        credit: 100_000,
        amount: 100_000,
        balance: 875_000,
      }),
      tx({
        transaction_date: "2026-05-05",
        description: "FairMoney LOAN REPAYMENT",
        debit: 35_000,
        amount: -35_000,
        balance: 840_000,
      }),
      tx({
        transaction_date: "2026-05-06",
        description: "Reversal of-MOBILE TRF TO FID/ /TEST",
        credit: 20_000,
        amount: 20_000,
        balance: 860_000,
      }),
      tx({
        transaction_date: "2026-06-01",
        description: "VAT COMMISSION",
        debit: 3.75,
        amount: -3.75,
        balance: 859_996.25,
      }),
    ];

    const analysis = analyzeStatement({
      statement: baseStatement,
      transactions,
      reconciled: true,
    });

    expect(analysis.meta.version).toBe("2.2.0");
    expect(analysis.meta.limitations.length).toBeGreaterThan(0);
    expect(analysis.totals.net_deposit).toBe(analysis.totals.total_deposit - 20_000);
    expect(analysis.income.total_salary).toBe(1_500_000);
    expect(analysis.flags.has_salary).toBe(true);
    expect(analysis.flags.has_recurring_income).toBe(true);
    expect(analysis.loans.lenders).toContain("FairMoney");
    expect(analysis.loans.events.some((e) => e.side === "disbursement")).toBe(true);
    expect(analysis.loans.events.some((e) => e.side === "repayment")).toBe(true);
    expect(analysis.signals.some((s) => s.code === "HAS_SALARY" && s.value)).toBe(true);
    expect(analysis.score_factors.length).toBeGreaterThan(3);
    expect(analysis.decision_support.recommendation).toMatch(/proceed|review|decline_support/);
    expect(analysis.behavior.spike).toBeTruthy();
    expect(analysis.name_check.confidence).toBeGreaterThan(0);
    expect(analysis.score).toBeGreaterThanOrEqual(0);
    expect(analysis.score).toBeLessThanOrEqual(100);
    expect(analysis.timing.week_of_month.length).toBeGreaterThan(0);
    expect(analysis.timing.by_weekday).toHaveLength(7);
    expect(analysis.timing.week_of_month_totals).toHaveLength(4);
    expect(analysis.timing.peak_inflow_week_of_month).toBeTruthy();
    expect(analysis.timing.loans.by_weekday).toHaveLength(7);
    expect(analysis.timing.loans.week_of_month_totals).toHaveLength(4);
    expect(
      analysis.timing.loans.peak_disbursement_week_of_month != null ||
        analysis.timing.loans.peak_repayment_week_of_month != null,
    ).toBe(true);
  });

  it("counts unique overdraft calendar days and clamps activity to 100%", () => {
    const transactions = [
      tx({
        transaction_date: "2026-04-01",
        description: "Opening move",
        credit: 10_000,
        amount: 10_000,
        balance: 5_000,
      }),
      tx({
        transaction_date: "2026-04-20",
        description: "OD transfer A",
        debit: 20_000,
        amount: -20_000,
        balance: -1_000,
      }),
      tx({
        transaction_date: "2026-04-20",
        description: "OD fee B",
        debit: 500,
        amount: -500,
        balance: -1_500,
      }),
      tx({
        transaction_date: "2026-04-20",
        description: "OD fee C",
        debit: 100,
        amount: -100,
        balance: -1_600,
      }),
      tx({
        transaction_date: "2026-09-30",
        description: "Recovery",
        credit: 50_000,
        amount: 50_000,
        balance: 48_400,
      }),
    ];
    const analysis = analyzeStatement({
      statement: {
        ...baseStatement,
        statement_period_start: "2026-04-01",
        statement_period_end: "2026-09-30",
      },
      transactions,
      reconciled: true,
    });
    expect(analysis.cashflow.overdraft_days).toBe(1);
    expect(analysis.cashflow.highest_overdraft).toBe(-1_600);
    expect(analysis.activity.monthly_deposit_activity_pct).toBeLessThanOrEqual(100);
    expect(analysis.activity.monthly_withdrawal_activity_pct).toBeLessThanOrEqual(100);
    expect(analysis.flags.is_overdraft).toBe(true);
  });

  it("flags gambler from betting inflows even without stakes", () => {
    const transactions = [
      tx({
        transaction_date: "2026-04-01",
        description: "NIP From BET9JA/WINNINGS",
        credit: 900_000,
        amount: 900_000,
        balance: 1_000_000,
      }),
      tx({
        transaction_date: "2026-04-15",
        description: "Transfer from SportyBet cashout",
        credit: 1_003_000,
        amount: 1_003_000,
        balance: 2_003_000,
      }),
    ];
    const analysis = analyzeStatement({
      statement: baseStatement,
      transactions,
      reconciled: false,
    });
    expect(analysis.spend.total_gambling).toBe(0);
    expect(analysis.spend.total_gambling_inflow).toBe(1_903_000);
    expect(analysis.flags.is_gambler).toBe(true);
    expect(analysis.signals.some((s) => s.code === "IS_GAMBLER" && s.value)).toBe(true);
    expect(analysis.totals.gamble_to_deposit_ratio).toBeGreaterThan(0);
    expect(analysis.decision_support.summary).toMatch(/tagged as a gambler/i);
  });

  it("flags gambler when only signed amount is set (credit/debit null)", () => {
    // Simulate poorly reconstructed rows that never filled credit/debit sides.
    const transactions = [
      {
        ...tx({
          transaction_date: "2026-04-01",
          description: "Paystack/Transfer from Bet9jaBet9ja",
          amount: 500_000,
          balance: 600_000,
        }),
        credit: null,
        debit: null,
        amount: 500_000,
      },
      {
        ...tx({
          transaction_date: "2026-04-20",
          description: "Paystack/sportybet.com Sporty",
          amount: 250_000,
          balance: 850_000,
        }),
        credit: null,
        debit: null,
        amount: 250_000,
      },
    ];
    expect(transactions.every((t) => t.credit == null && t.debit == null)).toBe(true);
    const analysis = analyzeStatement({
      statement: baseStatement,
      transactions,
      reconciled: false,
    });
    expect(analysis.spend.total_gambling_inflow).toBe(750_000);
    expect(analysis.flags.is_gambler).toBe(true);
    expect(analysis.flags.regular_gambler).toBe(true);
  });
});

describe("day / week timing analytics", () => {
  it("maps day-of-month into PHP week buckets (W5 merges into W4)", () => {
    const transactions = [
      tx({
        transaction_date: "2026-01-01",
        description: "INFLOW W1",
        credit: 10_000,
        amount: 10_000,
        balance: 110_000,
      }),
      tx({
        transaction_date: "2026-01-08",
        description: "INFLOW W2",
        credit: 20_000,
        amount: 20_000,
        balance: 130_000,
      }),
      tx({
        transaction_date: "2026-01-15",
        description: "INFLOW W3",
        credit: 30_000,
        amount: 30_000,
        balance: 160_000,
      }),
      tx({
        transaction_date: "2026-01-22",
        description: "INFLOW W4",
        credit: 40_000,
        amount: 40_000,
        balance: 200_000,
      }),
      tx({
        transaction_date: "2026-01-30",
        description: "INFLOW W5→W4",
        credit: 5_000,
        amount: 5_000,
        balance: 205_000,
      }),
      tx({
        transaction_date: "2026-01-10",
        description: "OUTFLOW W2",
        debit: 7_000,
        amount: -7_000,
        balance: 198_000,
      }),
    ];
    const analysis = analyzeStatement({
      statement: { ...baseStatement, statement_period_start: "2026-01-01", statement_period_end: "2026-01-31" },
      transactions,
    });
    const jan = analysis.timing.week_of_month.filter((r) => r.month === "2026-01");
    expect(jan.map((r) => r.week).sort()).toEqual([1, 2, 3, 4]);
    expect(jan.find((r) => r.week === 1)?.deposit).toBe(10_000);
    expect(jan.find((r) => r.week === 2)?.deposit).toBe(20_000);
    expect(jan.find((r) => r.week === 3)?.deposit).toBe(30_000);
    expect(jan.find((r) => r.week === 4)?.deposit).toBe(45_000); // 40k + 5k from day 30
    expect(jan.find((r) => r.week === 2)?.withdrawal).toBe(7_000);
    expect(analysis.timing.peak_inflow_week_of_month).toBe(4);
    expect(analysis.timing.peak_inflow_day_of_month).toBe(22);
    expect(analysis.timing.by_weekday).toHaveLength(7);
  });

  it("tracks loan disbursement vs repayment day and week peaks", () => {
    const transactions = [
      tx({
        transaction_date: "2026-03-03", // week 1
        description: "FairMoney LOAN DISBURSEMENT",
        credit: 200_000,
        amount: 200_000,
        balance: 300_000,
      }),
      tx({
        transaction_date: "2026-03-20", // week 3
        description: "FairMoney LOAN REPAYMENT",
        debit: 50_000,
        amount: -50_000,
        balance: 250_000,
      }),
      tx({
        transaction_date: "2026-04-18", // week 3
        description: "FairMoney LOAN REPAYMENT",
        debit: 50_000,
        amount: -50_000,
        balance: 200_000,
      }),
    ];
    const analysis = analyzeStatement({
      statement: { ...baseStatement, statement_period_start: "2026-03-01", statement_period_end: "2026-04-30" },
      transactions,
    });
    expect(analysis.timing.loans.peak_disbursement_week_of_month).toBe(1);
    expect(analysis.timing.loans.peak_repayment_week_of_month).toBe(3);
    expect(analysis.timing.loans.peak_disbursement_day_of_month).toBe(3);
    expect(analysis.timing.loans.peak_repayment_day_of_month).toBe(18);
    const loanSumD = analysis.timing.loans.week_of_month_totals.reduce((s, w) => s + w.disbursed, 0);
    const loanSumR = analysis.timing.loans.week_of_month_totals.reduce((s, w) => s + w.repaid, 0);
    expect(loanSumD).toBe(analysis.loans.total_disbursed);
    expect(loanSumR).toBe(analysis.loans.total_repaid);
  });

  it("refreshes stale archived analyses missing timing.loans", () => {
    const transactions = [
      tx({
        transaction_date: "2026-02-10",
        description: "FairMoney LOAN DISBURSEMENT",
        credit: 80_000,
        amount: 80_000,
        balance: 180_000,
      }),
    ];
    const stale = {
      statement_id: "stmt_stale",
      statement: {
        account_name: "SAMUEL CHIDI UDEGBUNAM",
        account_number: "0020044889",
        bank_name: "Access Bank",
        currency: "NGN",
        statement_period: { from: "2026-02-01", to: "2026-02-28" },
        opening_balance: 100_000,
        closing_balance: 180_000,
      },
      transactions,
      analysis: { score: 50, meta: { version: "2.0.0" } },
      validation: { reconciled: true },
    };
    expect(needsAnalysisRefresh(stale.analysis)).toBe(true);
    const { payload, refreshed, analysis } = ensureFreshAnalysis(stale);
    expect(refreshed).toBe(true);
    expect(analysis?.timing.loans.by_weekday).toHaveLength(7);
    expect(payload.analysis).toBeTruthy();
    expect(needsAnalysisRefresh(payload.analysis)).toBe(false);
  });
});
