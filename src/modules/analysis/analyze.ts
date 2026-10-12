/**
 * Production-oriented statement analysis.
 * Descriptive + decision-support signals with confidence — not a credit bureau score.
 */

import type { Statement, Transaction } from "../../contracts/index.js";
import {
  classifyNarration,
  gamblingConfidence,
  isBenefit,
  isReligion,
  isReversal,
  loanConfidence,
  nameMatchScore,
  salaryConfidence,
} from "./classify.js";
import { detectIncomeClusters } from "./income.js";
import type { AnalysisCategory } from "./patterns.js";
import { buildScorecard } from "./scorecard.js";
import type {
  AnalysisSignal,
  CategoryBucket,
  DayOfMonthBucket,
  LoanEvent,
  LoanTimingAnalytics,
  LoanTimingBucket,
  MonthlyBucket,
  PartyStat,
  StatementAnalysis,
  TimingAnalytics,
  WeekdayBucket,
  WeekOfMonthCell,
} from "./types.js";

export type { StatementAnalysis } from "./types.js";

const ANALYSIS_VERSION = "2.2.0";

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** PHP Analyses::week_number — ceil(day_of_month / 7); week 5 merges into 4. */
function weekOfMonth(iso: string): 1 | 2 | 3 | 4 {
  const day = Number(iso.slice(8, 10));
  if (!Number.isFinite(day) || day < 1) return 1;
  const w = Math.ceil(day / 7);
  if (w >= 5) return 4;
  return Math.max(1, Math.min(4, w)) as 1 | 2 | 3 | 4;
}

function weekdayIndex(iso: string): number | null {
  const t = Date.parse(`${iso}T12:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t).getUTCDay();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function safeDiv(num: number, den: number): number | null {
  if (!den) return null;
  return round2(num / den);
}

function monthKey(iso: string | null): string | null {
  if (!iso || iso.length < 7) return null;
  return iso.slice(0, 7);
}

function daysBetween(from: string | null, to: string | null): number {
  if (!from || !to) return 0;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

function estimateMonths(days: number): number {
  const raw = days / 30;
  const whole = Math.floor(raw);
  const frac = raw - whole;
  let months = frac > 0.4 ? whole + 1 : whole;
  if (months < 1) months = 1;
  return months;
}

/** Inclusive calendar months between YYYY-MM-DD bounds (Apr→Sep = 6). */
function calendarMonthsSpanned(from: string | null, to: string | null): number {
  if (!from || !to || from.length < 7 || to.length < 7) return 0;
  const fy = Number(from.slice(0, 4));
  const fm = Number(from.slice(5, 7));
  const ty = Number(to.slice(0, 4));
  const tm = Number(to.slice(5, 7));
  if (![fy, fm, ty, tm].every((n) => Number.isFinite(n) && n > 0)) return 0;
  return Math.max(1, (ty - fy) * 12 + (tm - fm) + 1);
}

function partyFromDescription(desc: string | null, side: "to" | "from"): string | null {
  if (!desc) return null;
  const cleaned = desc.replace(/\s+/g, " ").trim();
  if (side === "to") {
    const m =
      /(?:TRF TO|TRANSFER TO|TO)\s+[A-Z]{2,4}\/?\s*\/?\s*([A-Z0-9][A-Z0-9 .,'&-]{2,60})/i.exec(
        cleaned,
      ) ?? /\/\s*\/\s*([A-Z][A-Z0-9 .,'&-]{2,60})/i.exec(cleaned);
    return m?.[1]?.trim().slice(0, 60) ?? null;
  }
  const m =
    /(?:Transfer from|FROM)\s+([A-Z][A-Z0-9 .,'&-]{2,60})/i.exec(cleaned) ??
    /NIP\s+([A-Z][A-Z0-9 .,'&-]{2,40})/i.exec(cleaned);
  return m?.[1]?.trim().slice(0, 60) ?? null;
}

function bumpParty(map: Map<string, PartyStat>, name: string, amount: number): void {
  const key = name.toUpperCase();
  const cur = map.get(key) ?? { name: name.trim(), count: 0, total: 0 };
  cur.count += 1;
  cur.total = round2(cur.total + amount);
  map.set(key, cur);
}

function topParties(map: Map<string, PartyStat>, limit = 10): PartyStat[] {
  return [...map.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}

function bumpCategory(
  map: Map<AnalysisCategory, CategoryBucket>,
  category: AnalysisCategory,
  debit: number,
  credit: number,
): void {
  const cur = map.get(category) ?? {
    category,
    count: 0,
    debit_total: 0,
    credit_total: 0,
  };
  cur.count += 1;
  cur.debit_total = round2(cur.debit_total + debit);
  cur.credit_total = round2(cur.credit_total + credit);
  map.set(category, cur);
}

function signal(
  code: string,
  value: boolean,
  confidence: number,
  evidence: string[],
): AnalysisSignal {
  return {
    code,
    value,
    confidence: round2(Math.max(0, Math.min(1, confidence))),
    evidence,
  };
}

export function analyzeStatement(params: {
  statement: Statement;
  transactions: Transaction[];
  reconciled?: boolean;
  /** Optional requested repayment / loan amount for DTI-style proxy. */
  requested_amount?: number | null;
}): StatementAnalysis {
  const { statement, transactions } = params;
  const accountName = statement.account?.account_name ?? null;
  const reconciled = params.reconciled === true;

  const periodFrom =
    statement.statement_period_start ??
    transactions.find((t) => t.transaction_date)?.transaction_date ??
    null;
  const periodTo =
    statement.statement_period_end ??
    [...transactions].reverse().find((t) => t.transaction_date)?.transaction_date ??
    null;
  const days = daysBetween(periodFrom, periodTo);
  // Prefer calendar month span so activity % cannot exceed 100% when every month is active.
  const months = calendarMonthsSpanned(periodFrom, periodTo) || estimateMonths(days);

  let totalDeposit = 0;
  let totalWithdrawal = 0;
  let reversalCredit = 0;
  let reversalCount = 0;
  let salaryTotal = 0;
  let salaryCount = 0;
  let salaryConfSum = 0;
  let benefitTotal = 0;
  let loanIn = 0;
  let loanOut = 0;
  let loanCount = 0;
  let gamblingTotal = 0;
  let gamblingCount = 0;
  let gamblingInflowTotal = 0;
  let gamblingInflowCount = 0;
  let gamblingConfSum = 0;
  let gamblingEventCount = 0;
  let religionTotal = 0;
  let entertainmentTotal = 0;
  let atmTotal = 0;
  let posTotal = 0;
  let airtimeTotal = 0;
  let bankCharges = 0;
  let utilityTotal = 0;
  let investmentTotal = 0;
  let otherIncome = 0;

  let balanceSum = 0;
  let balanceDays = 0;
  let lowestBalance: number | null = null;
  let highestBalance: number | null = null;
  let highestOverdraft: number | null = null;
  let daysAbove20 = 0;
  let daysAbove50 = 0;

  const depositDates = new Set<string>();
  const withdrawDates = new Set<string>();
  const allDates = new Set<string>();
  const overdraftDates = new Set<string>();
  const zeroBalanceDates = new Set<string>();
  const lenders = new Set<string>();
  const loanEvents: LoanEvent[] = [];
  let lastLoanAmount: number | null = null;
  let lastLoanDate: string | null = null;

  let bestNameScore = 0;
  let nameHitCount = 0;

  const categories = new Map<AnalysisCategory, CategoryBucket>();
  const monthly = new Map<string, MonthlyBucket>();
  const recipients = new Map<string, PartyStat>();
  const senders = new Map<string, PartyStat>();
  const creditByDate = new Map<string, number>();

  type WomAgg = {
    deposit: number;
    withdrawal: number;
    salary: number;
    benefit: number;
    loan_disbursed: number;
    loan_repaid: number;
  };
  const weekOfMonthMap = new Map<string, WomAgg>();
  const weekdayAgg: Array<{ credit: number; debit: number; cN: number; dN: number }> = Array.from(
    { length: 7 },
    () => ({ credit: 0, debit: 0, cN: 0, dN: 0 }),
  );
  const dayOfMonthAgg: Array<{ credit: number; debit: number; cN: number; dN: number }> = Array.from(
    { length: 32 },
    () => ({ credit: 0, debit: 0, cN: 0, dN: 0 }),
  );

  const womKey = (month: string, week: number) => `${month}|${week}`;
  const ensureWom = (month: string, week: 1 | 2 | 3 | 4): WomAgg => {
    const k = womKey(month, week);
    let cur = weekOfMonthMap.get(k);
    if (!cur) {
      cur = {
        deposit: 0,
        withdrawal: 0,
        salary: 0,
        benefit: 0,
        loan_disbursed: 0,
        loan_repaid: 0,
      };
      weekOfMonthMap.set(k, cur);
    }
    return cur;
  };

  const depositBands: Record<string, number> = {
    "0-10k": 0,
    "10k-100k": 0,
    "100k-1M": 0,
    "1M-10M": 0,
    "10M-100M": 0,
    "100M+": 0,
  };

  const ensureMonth = (key: string): MonthlyBucket => {
    let m = monthly.get(key);
    if (!m) {
      m = {
        month: key,
        credit_total: 0,
        debit_total: 0,
        credit_count: 0,
        debit_count: 0,
        net: 0,
        average_balance: null,
        salary_total: 0,
        loan_disbursed: 0,
        loan_repaid: 0,
        gambling_total: 0,
        max_single_deposit: 0,
        deposit_sweep_ratio: null,
      };
      monthly.set(key, m);
    }
    return m;
  };

  const monthBalanceSums = new Map<string, { sum: number; n: number }>();

  for (const tx of transactions) {
    const date = tx.transaction_date;
    // Prefer explicit debit/credit; fall back to signed amount when sides were not reconstructed.
    let debit = tx.debit != null ? Math.abs(Number(tx.debit)) : 0;
    let credit = tx.credit != null ? Math.abs(Number(tx.credit)) : 0;
    if (debit === 0 && credit === 0 && tx.amount != null && Number.isFinite(Number(tx.amount))) {
      const amt = Number(tx.amount);
      if (amt > 0) credit = Math.abs(amt);
      else if (amt < 0) debit = Math.abs(amt);
    }
    const desc = tx.description ?? "";
    const classified = classifyNarration(desc);
    const rev = isReversal(desc) || classified.category === "reversal";
    const loanMeta = loanConfidence(desc);
    const gambleMeta = gamblingConfidence(desc);
    const salMeta = salaryConfidence(desc);

    bumpCategory(categories, classified.category, debit, credit);

    if (credit > 0) {
      totalDeposit += credit;
      if (date) {
        depositDates.add(date);
        creditByDate.set(date, round2((creditByDate.get(date) ?? 0) + credit));
      }
      if (rev) {
        reversalCredit += credit;
        reversalCount += 1;
      }
      if (credit < 10_000) depositBands["0-10k"] += 1;
      else if (credit < 100_000) depositBands["10k-100k"] += 1;
      else if (credit < 1_000_000) depositBands["100k-1M"] += 1;
      else if (credit < 10_000_000) depositBands["1M-10M"] += 1;
      else if (credit < 100_000_000) depositBands["10M-100M"] += 1;
      else depositBands["100M+"] += 1;

      if (salMeta.hit) {
        salaryTotal += credit;
        salaryCount += 1;
        salaryConfSum += salMeta.confidence;
      } else if (isBenefit(desc)) {
        benefitTotal += credit;
      } else if (loanMeta.hit) {
        const side =
          loanMeta.side === "repayment"
            ? "repayment"
            : loanMeta.side === "disbursement"
              ? "disbursement"
              : "disbursement";
        if (side === "disbursement") {
          loanIn += credit;
          loanCount += 1;
          if (loanMeta.lender) lenders.add(loanMeta.lender);
          lastLoanAmount = credit;
          lastLoanDate = date;
          loanEvents.push({
            date,
            amount: credit,
            side: "disbursement",
            lender: loanMeta.lender,
            description: desc.slice(0, 120),
            confidence: loanMeta.confidence,
          });
        }
      } else if (!rev && classified.category !== "transfer") {
        otherIncome += credit;
      }

      // Betting winnings / cashouts are gambling activity even without stakes on this statement.
      if (gambleMeta.hit) {
        gamblingInflowTotal += credit;
        gamblingInflowCount += 1;
        gamblingEventCount += 1;
        gamblingConfSum += gambleMeta.confidence;
      }

      const sender = partyFromDescription(desc, "from");
      if (sender) bumpParty(senders, sender, credit);
    }

    if (debit > 0) {
      totalWithdrawal += debit;
      if (date) withdrawDates.add(date);

      if (loanMeta.hit) {
        const side =
          loanMeta.side === "disbursement"
            ? "disbursement"
            : "repayment";
        if (side === "repayment" || loanMeta.side === "unknown" || loanMeta.side === "repayment") {
          // Debit + loan keywords ⇒ repayment
          loanOut += debit;
          loanCount += 1;
          if (loanMeta.lender) lenders.add(loanMeta.lender);
          loanEvents.push({
            date,
            amount: debit,
            side: "repayment",
            lender: loanMeta.lender,
            description: desc.slice(0, 120),
            confidence: loanMeta.confidence,
          });
        }
      }

      if (classified.category === "atm") atmTotal += debit;
      if (classified.category === "pos") posTotal += debit;
      if (classified.category === "airtime") airtimeTotal += debit;
      if (classified.category === "bank_charge") bankCharges += debit;
      if (classified.category === "investment") investmentTotal += debit;
      if (["electricity", "water", "cable_tv", "bills"].includes(classified.category)) {
        utilityTotal += debit;
      }
      if (gambleMeta.hit) {
        gamblingTotal += debit;
        gamblingCount += 1;
        gamblingEventCount += 1;
        gamblingConfSum += gambleMeta.confidence;
      }
      if (isReligion(desc) || classified.category === "religion") religionTotal += debit;
      if (classified.category === "entertainment") entertainmentTotal += debit;

      const recipient = partyFromDescription(desc, "to");
      if (recipient) bumpParty(recipients, recipient, debit);
    }

    if (date) {
      allDates.add(date);
      const mk = monthKey(date);
      const wom = weekOfMonth(date);
      const wd = weekdayIndex(date);
      const dom = Number(date.slice(8, 10));

      if (mk) {
        const m = ensureMonth(mk);
        const cell = ensureWom(mk, wom);
        if (credit > 0) {
          m.credit_total = round2(m.credit_total + credit);
          m.credit_count += 1;
          m.max_single_deposit = Math.max(m.max_single_deposit, credit);
          if (salMeta.hit) m.salary_total = round2(m.salary_total + credit);
          // Track gambling activity in monthly bucket (stakes + winnings).
          if (gambleMeta.hit) m.gambling_total = round2(m.gambling_total + credit);
          cell.deposit = round2(cell.deposit + credit);
          if (salMeta.hit) cell.salary = round2(cell.salary + credit);
          else if (isBenefit(desc)) cell.benefit = round2(cell.benefit + credit);
        }
        if (debit > 0) {
          m.debit_total = round2(m.debit_total + debit);
          m.debit_count += 1;
          if (gambleMeta.hit) m.gambling_total = round2(m.gambling_total + debit);
          cell.withdrawal = round2(cell.withdrawal + debit);
        }
        m.net = round2(m.credit_total - m.debit_total);
      }

      if (wd != null && wd >= 0 && wd <= 6) {
        if (credit > 0) {
          weekdayAgg[wd].credit = round2(weekdayAgg[wd].credit + credit);
          weekdayAgg[wd].cN += 1;
        }
        if (debit > 0) {
          weekdayAgg[wd].debit = round2(weekdayAgg[wd].debit + debit);
          weekdayAgg[wd].dN += 1;
        }
      }
      if (Number.isFinite(dom) && dom >= 1 && dom <= 31) {
        if (credit > 0) {
          dayOfMonthAgg[dom].credit = round2(dayOfMonthAgg[dom].credit + credit);
          dayOfMonthAgg[dom].cN += 1;
        }
        if (debit > 0) {
          dayOfMonthAgg[dom].debit = round2(dayOfMonthAgg[dom].debit + debit);
          dayOfMonthAgg[dom].dN += 1;
        }
      }
    }

    if (tx.balance != null) {
      balanceSum += tx.balance;
      balanceDays += 1;
      lowestBalance =
        lowestBalance == null ? tx.balance : Math.min(lowestBalance, tx.balance);
      highestBalance =
        highestBalance == null ? tx.balance : Math.max(highestBalance, tx.balance);
      if (Math.abs(tx.balance) < 0.005) {
        zeroBalanceDates.add(date ?? `row_${balanceDays}`);
      }
      if (tx.balance < 0) {
        overdraftDates.add(date ?? `row_${balanceDays}`);
        highestOverdraft =
          highestOverdraft == null
            ? tx.balance
            : Math.min(highestOverdraft, tx.balance);
      }
      const mk = monthKey(date);
      if (mk) {
        const cur = monthBalanceSums.get(mk) ?? { sum: 0, n: 0 };
        cur.sum += tx.balance;
        cur.n += 1;
        monthBalanceSums.set(mk, cur);
      }
    }

    const ns = nameMatchScore(accountName, desc);
    if (ns > 0) {
      nameHitCount += 1;
      bestNameScore = Math.max(bestNameScore, ns);
    }
  }

  // Fix double-count bug on loan_disbursed — recompute monthly loan fields cleanly
  for (const m of monthly.values()) {
    m.loan_disbursed = 0;
    m.loan_repaid = 0;
  }
  for (const ev of loanEvents) {
    const mk = monthKey(ev.date);
    if (!mk || !ev.date) continue;
    const m = ensureMonth(mk);
    const cell = ensureWom(mk, weekOfMonth(ev.date));
    if (ev.side === "disbursement") {
      m.loan_disbursed = round2(m.loan_disbursed + ev.amount);
      cell.loan_disbursed = round2(cell.loan_disbursed + ev.amount);
    } else {
      m.loan_repaid = round2(m.loan_repaid + ev.amount);
      cell.loan_repaid = round2(cell.loan_repaid + ev.amount);
    }
  }

  // Ensure every observed month has weeks 1–4 (PHP fills missing weeks with zeros).
  for (const mk of monthly.keys()) {
    for (const w of [1, 2, 3, 4] as const) ensureWom(mk, w);
  }

  const weekOfMonthList: WeekOfMonthCell[] = [...weekOfMonthMap.entries()]
    .map(([k, v]) => {
      const [month, weekStr] = k.split("|");
      return {
        month,
        week: Number(weekStr) as 1 | 2 | 3 | 4,
        deposit: v.deposit,
        withdrawal: v.withdrawal,
        salary: v.salary,
        benefit: v.benefit,
        loan_disbursed: v.loan_disbursed,
        loan_repaid: v.loan_repaid,
      };
    })
    .sort((a, b) => (a.month === b.month ? a.week - b.week : a.month.localeCompare(b.month)));

  const weekOfMonthTotals = ([1, 2, 3, 4] as const).map((week) => {
    const rows = weekOfMonthList.filter((r) => r.week === week);
    return {
      week,
      deposit: round2(rows.reduce((s, r) => s + r.deposit, 0)),
      withdrawal: round2(rows.reduce((s, r) => s + r.withdrawal, 0)),
      salary: round2(rows.reduce((s, r) => s + r.salary, 0)),
      benefit: round2(rows.reduce((s, r) => s + r.benefit, 0)),
      loan_disbursed: round2(rows.reduce((s, r) => s + r.loan_disbursed, 0)),
      loan_repaid: round2(rows.reduce((s, r) => s + r.loan_repaid, 0)),
    };
  });

  const byWeekday: WeekdayBucket[] = WEEKDAY_LABELS.map((label, weekday) => ({
    weekday,
    label,
    credit_total: weekdayAgg[weekday].credit,
    debit_total: weekdayAgg[weekday].debit,
    credit_count: weekdayAgg[weekday].cN,
    debit_count: weekdayAgg[weekday].dN,
  }));

  const byDayOfMonth: DayOfMonthBucket[] = [];
  for (let day = 1; day <= 31; day += 1) {
    const d = dayOfMonthAgg[day];
    if (d.credit > 0 || d.debit > 0 || d.cN > 0 || d.dN > 0) {
      byDayOfMonth.push({
        day,
        credit_total: d.credit,
        debit_total: d.debit,
        credit_count: d.cN,
        debit_count: d.dN,
      });
    }
  }

  const peakWd = [...byWeekday].sort((a, b) => b.credit_total - a.credit_total)[0];
  const peakWom = [...weekOfMonthTotals].sort((a, b) => b.deposit - a.deposit)[0];
  const peakDom = [...byDayOfMonth].sort((a, b) => b.credit_total - a.credit_total)[0];

  // Loan disbursement / repayment timing (PHP loan_dmweek + loan_week patterns).
  const loanWeekdayAgg: Array<{
    disbursed: number;
    repaid: number;
    dN: number;
    rN: number;
  }> = Array.from({ length: 7 }, () => ({ disbursed: 0, repaid: 0, dN: 0, rN: 0 }));
  const loanDomAgg: Array<{
    disbursed: number;
    repaid: number;
    dN: number;
    rN: number;
  }> = Array.from({ length: 32 }, () => ({ disbursed: 0, repaid: 0, dN: 0, rN: 0 }));

  for (const ev of loanEvents) {
    if (!ev.date || ev.date.length < 10) continue;
    const wd = weekdayIndex(ev.date);
    const dom = Number(ev.date.slice(8, 10));
    if (wd != null && wd >= 0 && wd <= 6) {
      if (ev.side === "disbursement") {
        loanWeekdayAgg[wd].disbursed = round2(loanWeekdayAgg[wd].disbursed + ev.amount);
        loanWeekdayAgg[wd].dN += 1;
      } else {
        loanWeekdayAgg[wd].repaid = round2(loanWeekdayAgg[wd].repaid + ev.amount);
        loanWeekdayAgg[wd].rN += 1;
      }
    }
    if (Number.isFinite(dom) && dom >= 1 && dom <= 31) {
      if (ev.side === "disbursement") {
        loanDomAgg[dom].disbursed = round2(loanDomAgg[dom].disbursed + ev.amount);
        loanDomAgg[dom].dN += 1;
      } else {
        loanDomAgg[dom].repaid = round2(loanDomAgg[dom].repaid + ev.amount);
        loanDomAgg[dom].rN += 1;
      }
    }
  }

  const loanByWeekday: LoanTimingBucket[] = WEEKDAY_LABELS.map((label, weekday) => ({
    key: String(weekday),
    label,
    disbursed: loanWeekdayAgg[weekday].disbursed,
    repaid: loanWeekdayAgg[weekday].repaid,
    disbursed_count: loanWeekdayAgg[weekday].dN,
    repaid_count: loanWeekdayAgg[weekday].rN,
  }));

  const loanByDayOfMonth: LoanTimingBucket[] = [];
  for (let day = 1; day <= 31; day += 1) {
    const d = loanDomAgg[day];
    if (d.disbursed > 0 || d.repaid > 0 || d.dN > 0 || d.rN > 0) {
      loanByDayOfMonth.push({
        key: String(day),
        label: String(day),
        disbursed: d.disbursed,
        repaid: d.repaid,
        disbursed_count: d.dN,
        repaid_count: d.rN,
      });
    }
  }

  const loanWeekTotals = ([1, 2, 3, 4] as const).map((week) => {
    const rows = weekOfMonthList.filter((r) => r.week === week);
    return {
      week,
      disbursed: round2(rows.reduce((s, r) => s + r.loan_disbursed, 0)),
      repaid: round2(rows.reduce((s, r) => s + r.loan_repaid, 0)),
    };
  });

  const peakLoan = (
    rows: Array<{ label?: string; week?: number; disbursed: number; repaid: number }>,
    side: "disbursed" | "repaid",
    pick: "label" | "week",
  ): string | number | null => {
    const sorted = [...rows].sort((a, b) => b[side] - a[side]);
    const top = sorted[0];
    if (!top || !(top[side] > 0)) return null;
    return pick === "label" ? (top.label ?? null) : (top.week ?? null);
  };

  const loanTiming: LoanTimingAnalytics = {
    week_of_month: weekOfMonthList,
    week_of_month_totals: loanWeekTotals,
    by_weekday: loanByWeekday,
    by_day_of_month: loanByDayOfMonth,
    peak_disbursement_weekday: peakLoan(loanByWeekday, "disbursed", "label") as string | null,
    peak_repayment_weekday: peakLoan(loanByWeekday, "repaid", "label") as string | null,
    peak_disbursement_week_of_month: peakLoan(
      loanWeekTotals.map((w) => ({ week: w.week, disbursed: w.disbursed, repaid: w.repaid })),
      "disbursed",
      "week",
    ) as number | null,
    peak_repayment_week_of_month: peakLoan(
      loanWeekTotals.map((w) => ({ week: w.week, disbursed: w.disbursed, repaid: w.repaid })),
      "repaid",
      "week",
    ) as number | null,
    peak_disbursement_day_of_month: (() => {
      const top = [...loanByDayOfMonth].sort((a, b) => b.disbursed - a.disbursed)[0];
      return top && top.disbursed > 0 ? Number(top.key) : null;
    })(),
    peak_repayment_day_of_month: (() => {
      const top = [...loanByDayOfMonth].sort((a, b) => b.repaid - a.repaid)[0];
      return top && top.repaid > 0 ? Number(top.key) : null;
    })(),
  };

  const timing: TimingAnalytics = {
    week_of_month: weekOfMonthList,
    week_of_month_totals: weekOfMonthTotals,
    by_weekday: byWeekday,
    by_day_of_month: byDayOfMonth,
    peak_inflow_weekday: peakWd && peakWd.credit_total > 0 ? peakWd.label : null,
    peak_inflow_week_of_month: peakWom && peakWom.deposit > 0 ? peakWom.week : null,
    peak_inflow_day_of_month: peakDom && peakDom.credit_total > 0 ? peakDom.day : null,
    loans: loanTiming,
  };

  for (const [mk, stats] of monthBalanceSums) {
    const m = monthly.get(mk);
    if (m && stats.n > 0) m.average_balance = round2(stats.sum / stats.n);
  }

  // Deposit sweep: month debit / month credit (higher = money leaves quickly)
  let highSweepMonths = 0;
  let sweepSum = 0;
  let sweepN = 0;
  for (const m of monthly.values()) {
    if (m.credit_total > 0) {
      const ratio = round2(m.debit_total / m.credit_total);
      m.deposit_sweep_ratio = ratio;
      sweepSum += ratio;
      sweepN += 1;
      if (ratio >= 0.9) highSweepMonths += 1;
    }
  }

  const monthlyList = [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month));
  // Average over calendar months in the statement span (idle months count as net 0).
  const avgMonthlyNetBasis = Math.max(months, monthlyList.length, 1);
  const avgMonthlyNet = monthlyList.length
    ? round2(monthlyList.reduce((s, m) => s + m.net, 0) / avgMonthlyNetBasis)
    : null;
  const overdraftDays = overdraftDates.size;
  const zeroBalanceDays = zeroBalanceDates.size;

  const avgDailyDepositAmt = safeDiv(totalDeposit, Math.max(depositDates.size, 1));
  if (avgDailyDepositAmt != null) {
    for (const tx of transactions) {
      if (tx.balance == null) continue;
      if (tx.balance >= avgDailyDepositAmt * 0.2) daysAbove20 += 1;
      if (tx.balance >= avgDailyDepositAmt * 0.5) daysAbove50 += 1;
    }
  }

  // Inflow concentration / spikes
  const sortedCreditDays = [...creditByDate.entries()].sort((a, b) => b[1] - a[1]);
  const top1 = sortedCreditDays[0]?.[1] ?? 0;
  const top3 = sortedCreditDays.slice(0, 3).reduce((s, [, v]) => s + v, 0);
  const last30Cutoff = periodTo
    ? new Date(Date.parse(periodTo) - 29 * 86_400_000).toISOString().slice(0, 10)
    : null;
  let last30 = 0;
  if (last30Cutoff) {
    for (const [d, v] of creditByDate) {
      if (d >= last30Cutoff) last30 += v;
    }
  }
  const oneDayPct = safeDiv(top1 * 100, totalDeposit || 0);
  const threeDayPct = safeDiv(top3 * 100, totalDeposit || 0);
  const thirtyDayPct = safeDiv(last30 * 100, totalDeposit || 0);
  const concentratedInflow = (oneDayPct ?? 0) >= 25 || (threeDayPct ?? 0) >= 45;

  const clusters = detectIncomeClusters(transactions);
  const confirmedClusters = clusters.filter((c) => c.label === "confirmed_salary");
  const suspectedClusters = clusters.filter((c) => c.label === "suspected_recurring_income");
  const suspectedRecurringTotal = round2(
    suspectedClusters.reduce((s, c) => s + c.total, 0),
  );
  const stableIncomeMonths = Math.max(
    0,
    ...clusters.map((c) => c.months.length),
    confirmedClusters.length ? Math.max(...confirmedClusters.map((c) => c.months.length)) : 0,
  );

  const depositDayCount = depositDates.size || 1;
  const withdrawDayCount = withdrawDates.size || 1;
  const avgDailyBalance = balanceDays > 0 ? round2(balanceSum / balanceDays) : null;
  const netDeposit = round2(totalDeposit - reversalCredit);
  const netWithdrawal = round2(totalWithdrawal - reversalCredit);
  const w2d = safeDiv(totalWithdrawal * 100, totalDeposit || 0);
  const gamblingActivityTotal = round2(gamblingTotal + gamblingInflowTotal);
  // Include stakes + betting inflows so winnings-only activity is not shown as 0%.
  const g2d = safeDiv(gamblingActivityTotal * 100, totalDeposit || 0);

  const activeDepositMonths = monthlyList.filter((m) => m.credit_total > 0).length;
  const activeWithdrawMonths = monthlyList.filter((m) => m.debit_total > 0).length;

  const closing =
    statement.closing_balance ??
    [...transactions].reverse().find((t) => t.balance != null)?.balance ??
    null;

  const avgGambleConf = gamblingEventCount ? gamblingConfSum / gamblingEventCount : 0;
  // Inflows from betting brands (winnings/cashouts) count as gambling activity.
  // Any clear betting inflow/outflow tags the owner — not only multi-stake patterns.
  const isGambler =
    gamblingCount >= 1 ||
    gamblingTotal > 0 ||
    gamblingInflowCount >= 1 ||
    gamblingInflowTotal > 0;
  const regularGambler =
    gamblingEventCount >= 4 ||
    gamblingActivityTotal / Math.max(months, 1) > 30_000 ||
    (gamblingInflowCount >= 2 && gamblingInflowTotal > 50_000) ||
    gamblingInflowTotal >= 500_000;
  const isBorrower = loanIn + loanOut > 0;
  const frequentBorrower = loanEvents.length >= 4 || lenders.size >= 2;
  const hasSalary = salaryCount >= 1 || confirmedClusters.length > 0;
  const hasRecurringIncome = hasSalary || suspectedClusters.length > 0;
  const avgSalaryConf = salaryCount ? salaryConfSum / salaryCount : confirmedClusters[0]?.confidence ?? 0;

  let isStatementRecent = false;
  if (periodTo) {
    const ageDays = (Date.now() - Date.parse(periodTo)) / 86_400_000;
    isStatementRecent = Number.isFinite(ageDays) && ageDays <= 45;
  }

  const nameMatched = bestNameScore >= 40 || nameHitCount >= 3;
  const nameConfidence = nameMatched ? Math.min(0.95, 0.4 + bestNameScore / 100) : 0.45;

  const repaymentCoverage = loanIn > 0 ? round2(loanOut / loanIn) : loanOut > 0 ? 1 : null;

  const requested = params.requested_amount ?? null;
  const estimatedDti =
    requested && requested > 0 && avgMonthlyNet != null && avgMonthlyNet > 0
      ? round2(requested / avgMonthlyNet)
      : null;

  const scorecard = buildScorecard({
    hasConfirmedSalary: hasSalary,
    hasRecurringIncome,
    salaryConfidence: avgSalaryConf || 0.6,
    nameScore: bestNameScore,
    nameConfidence,
    reconciled,
    months,
    isGambler,
    gamblingConfidence: avgGambleConf || 0.7,
    regularGambler,
    isBorrower,
    frequentBorrower,
    overdraftDays,
    zeroBalanceDays,
    withdrawalToDeposit: w2d,
    gambleToDeposit: g2d,
    highSweepMonths,
    concentratedInflow,
    isStatementRecent,
    stableIncomeMonths,
    repaymentCoverage,
  });

  const signals: AnalysisSignal[] = [
    signal("HAS_SALARY", hasSalary, avgSalaryConf || (hasSalary ? 0.7 : 0.6), [
      `salary_count=${salaryCount}`,
      `confirmed_clusters=${confirmedClusters.length}`,
    ]),
    signal("HAS_RECURRING_INCOME", hasRecurringIncome, hasRecurringIncome ? 0.75 : 0.65, [
      `suspected_clusters=${suspectedClusters.length}`,
    ]),
    signal("IS_BORROWER", isBorrower, isBorrower ? 0.85 : 0.7, [`loan_events=${loanEvents.length}`]),
    signal("FREQUENT_BORROWER", frequentBorrower, 0.8, [`lenders=${lenders.size}`]),
    signal("IS_GAMBLER", isGambler, avgGambleConf || 0.7, [
      `gambling_debit_count=${gamblingCount}`,
      `gambling_credit_count=${gamblingInflowCount}`,
      `gambling_inflow=${round2(gamblingInflowTotal)}`,
    ]),
    signal("REGULAR_GAMBLER", regularGambler, avgGambleConf || 0.75, [
      `gambling_spend=${round2(gamblingTotal)}`,
      `gambling_inflow=${round2(gamblingInflowTotal)}`,
      `gambling_events=${gamblingEventCount}`,
    ]),
    signal("IS_OVERDRAFT", overdraftDays > 0, overdraftDays > 0 ? 0.95 : 0.9, [
      `overdraft_days=${overdraftDays}`,
    ]),
    signal("STATEMENT_RECENT", isStatementRecent, 0.9, [`period_to=${periodTo}`]),
    signal("RECONCILED", reconciled, 0.95, []),
    signal("CONCENTRATED_INFLOW", concentratedInflow, 0.75, [
      `one_day_pct=${oneDayPct}`,
      `three_day_pct=${threeDayPct}`,
    ]),
  ];

  const risks: AnalysisSignal<string>[] = [];
  const pushRisk = (code: string, confidence: number, evidence: string[]) => {
    risks.push({ code, value: code, confidence, evidence });
  };
  if (isGambler) {
    pushRisk("GAMBLING_ACTIVITY", avgGambleConf || 0.7, [
      `debit_count=${gamblingCount}`,
      `credit_count=${gamblingInflowCount}`,
      `inflow=${round2(gamblingInflowTotal)}`,
    ]);
  }
  if (regularGambler) {
    pushRisk("REGULAR_GAMBLER", avgGambleConf || 0.8, [
      `activity_total=${gamblingActivityTotal}`,
    ]);
  }
  if (overdraftDays > 0) pushRisk("OVERDRAFT_OBSERVED", 0.95, [`days=${overdraftDays}`]);
  if (zeroBalanceDays > 5) pushRisk("FREQUENT_ZERO_BALANCE", 0.85, [`days=${zeroBalanceDays}`]);
  if (w2d != null && w2d > 110) pushRisk("HIGH_WITHDRAWAL_RATIO", 0.85, [`ratio=${w2d}`]);
  if (!hasRecurringIncome && months >= 2) {
    pushRisk("NO_STABLE_INCOME", 0.7, ["no salary/recurring clusters"]);
  }
  if (frequentBorrower) pushRisk("FREQUENT_BORROWING", 0.8, [`events=${loanEvents.length}`]);
  if (!isStatementRecent) pushRisk("STATEMENT_NOT_RECENT", 0.75, [`to=${periodTo}`]);
  if (!reconciled) pushRisk("RECONCILIATION_MISMATCH", 0.9, []);
  if (highSweepMonths >= 3) pushRisk("DEPOSIT_SWEEP_PATTERN", 0.75, [`months=${highSweepMonths}`]);
  if (concentratedInflow) pushRisk("CONCENTRATED_INFLOW", 0.75, [`one_day_pct=${oneDayPct}`]);

  return {
    meta: {
      version: ANALYSIS_VERSION,
      generated_at: new Date().toISOString(),
      methodology:
        "Heuristic + pattern analytics with per-signal confidence. Scorecard is additive and confidence-weighted for underwriting support only.",
      limitations: [
        "Not a credit bureau or regulated credit score",
        "Narration classifiers can false-positive/negative",
        "Recurring-income clusters approximate payroll when keywords are absent",
        "Counterparty names are parsed from free-text narrations",
        "Should be validated against labeled statement sets before automated decisions",
      ],
    },
    score: scorecard.score,
    score_band: scorecard.score_band,
    score_factors: scorecard.factors,
    decision_support: {
      recommendation: scorecard.recommendation,
      reason_codes: scorecard.reason_codes,
      summary: (() => {
        let summary = scorecard.summary;
        if (isGambler) {
          const parts: string[] = [];
          if (gamblingInflowTotal > 0) {
            parts.push(`₦${round2(gamblingInflowTotal).toLocaleString("en-NG")} betting inflows`);
          }
          if (gamblingTotal > 0) {
            parts.push(`₦${round2(gamblingTotal).toLocaleString("en-NG")} stakes`);
          }
          summary += ` Owner is tagged as a gambler (${parts.join(", ") || "betting activity detected"}${
            regularGambler ? "; regular pattern" : ""
          }).`;
        }
        return summary;
      })(),
    },
    period: { from: periodFrom, to: periodTo, days, months },
    totals: {
      transaction_count: transactions.length,
      total_deposit: round2(totalDeposit),
      total_withdrawal: round2(totalWithdrawal),
      net_deposit: netDeposit,
      net_withdrawal: netWithdrawal,
      reversal_credit_total: round2(reversalCredit),
      reversal_count: reversalCount,
      average_daily_balance: avgDailyBalance,
      average_daily_deposit: safeDiv(totalDeposit, depositDayCount),
      average_daily_withdrawal: safeDiv(totalWithdrawal, withdrawDayCount),
      average_monthly_deposit: safeDiv(totalDeposit, months),
      average_monthly_withdrawal: safeDiv(totalWithdrawal, months),
      withdrawal_to_deposit_ratio: w2d,
      gamble_to_deposit_ratio: g2d,
      credit_turnover: safeDiv(totalDeposit, months),
      opening_balance: statement.opening_balance ?? null,
      closing_balance: statement.closing_balance ?? null,
      current_balance: closing,
      estimated_dti: estimatedDti,
    },
    signals,
    flags: {
      is_borrower: isBorrower,
      frequent_borrower: frequentBorrower,
      is_gambler: isGambler,
      regular_gambler: regularGambler,
      is_religion: religionTotal > 0,
      is_clubbing: entertainmentTotal > 0,
      is_overdraft: overdraftDays > 0,
      has_salary: hasSalary,
      has_recurring_income: hasRecurringIncome,
      is_statement_recent: isStatementRecent,
    },
    income: {
      total_salary: round2(salaryTotal),
      average_salary: salaryCount ? safeDiv(salaryTotal, salaryCount) : null,
      salary_count: salaryCount,
      confirmed_salary_confidence: round2(avgSalaryConf),
      suspected_salary_total: round2(salaryTotal + suspectedRecurringTotal),
      suspected_recurring_total: suspectedRecurringTotal,
      benefit_total: round2(benefitTotal),
      other_income: round2(otherIncome),
      clusters,
      stable_income_months: stableIncomeMonths,
    },
    loans: {
      total_disbursed: round2(loanIn),
      total_repaid: round2(loanOut),
      net_debt: round2(loanIn - loanOut),
      loan_count: loanCount,
      lenders: [...lenders],
      last_loan_amount: lastLoanAmount,
      last_loan_date: lastLoanDate,
      events: loanEvents,
      repayment_coverage: repaymentCoverage,
    },
    spend: {
      total_atm: round2(atmTotal),
      total_pos: round2(posTotal),
      total_gambling: round2(gamblingTotal),
      total_gambling_inflow: round2(gamblingInflowTotal),
      total_entertainment: round2(entertainmentTotal),
      total_religion: round2(religionTotal),
      total_airtime: round2(airtimeTotal),
      total_bank_charges: round2(bankCharges),
      total_utility: round2(utilityTotal),
      total_investment: round2(investmentTotal),
    },
    behavior: {
      average_deposit_sweep: sweepN ? round2(sweepSum / sweepN) : null,
      high_sweep_months: highSweepMonths,
      spike: {
        one_day_pct_of_credits: oneDayPct,
        three_day_pct_of_credits: threeDayPct,
        thirty_day_pct_of_credits: thirtyDayPct,
        concentrated_inflow: concentratedInflow,
      },
      balance_persistence: {
        days_above_20pct_avg_deposit: daysAbove20,
        days_above_50pct_avg_deposit: daysAbove50,
      },
    },
    cashflow: {
      monthly: monthlyList,
      average_monthly_net: avgMonthlyNet,
      lowest_balance: lowestBalance,
      highest_balance: highestBalance,
      zero_balance_days: zeroBalanceDays,
      overdraft_days: overdraftDays,
      highest_overdraft: highestOverdraft,
    },
    activity: {
      deposit_days: depositDates.size,
      withdrawal_days: withdrawDates.size,
      transaction_days: allDates.size,
      monthly_deposit_activity_pct: (() => {
        const basis = Math.max(months, monthlyList.length, 1);
        const raw = safeDiv(activeDepositMonths * 100, basis);
        return raw == null ? null : round2(Math.min(100, raw));
      })(),
      monthly_withdrawal_activity_pct: (() => {
        const basis = Math.max(months, monthlyList.length, 1);
        const raw = safeDiv(activeWithdrawMonths * 100, basis);
        return raw == null ? null : round2(Math.min(100, raw));
      })(),
    },
    timing,
    counterparties: {
      top_recipients: topParties(recipients),
      top_senders: topParties(senders),
      recipient_count: recipients.size,
      sender_count: senders.size,
    },
    categories: [...categories.values()].sort(
      (a, b) => b.debit_total + b.credit_total - (a.debit_total + a.credit_total),
    ),
    deposit_size_bands: depositBands,
    name_check: {
      code: "NAME_MATCH",
      value: nameMatched,
      confidence: round2(nameConfidence),
      evidence: [`best_score=${bestNameScore}`, `hit_count=${nameHitCount}`],
      account_name: accountName,
      score: bestNameScore,
      message: nameMatched
        ? "Account name appears in transaction narrations"
        : "Account name not clearly found in narrations",
    },
    risks,
  };
}
