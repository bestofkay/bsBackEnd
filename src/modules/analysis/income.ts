/**
 * Recurring-income detection beyond keyword salary matching.
 */

import type { Transaction } from "../../contracts/index.js";
import { isBenefit, isLoan, isReversal, isSalary, salaryConfidence } from "./classify.js";
import type { IncomeCluster } from "./types.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

function dayOfMonth(iso: string): number {
  return Number(iso.slice(8, 10));
}

function mode(nums: number[]): number | null {
  if (!nums.length) return null;
  const freq = new Map<number, number>();
  for (const n of nums) freq.set(n, (freq.get(n) ?? 0) + 1);
  let best: number | null = null;
  let bestN = 0;
  for (const [k, v] of freq) {
    if (v > bestN) {
      best = k;
      bestN = v;
    }
  }
  return best;
}

/**
 * Cluster similar credit amounts that recur across months (suspected salary / stable income).
 */
export function detectIncomeClusters(transactions: Transaction[]): IncomeCluster[] {
  type Credit = { date: string; amount: number; desc: string };
  const credits: Credit[] = [];
  for (const tx of transactions) {
    if (tx.credit == null || tx.credit <= 0 || !tx.transaction_date) continue;
    const desc = tx.description ?? "";
    if (isReversal(desc) || isLoan(desc)) continue;
    credits.push({
      date: tx.transaction_date,
      amount: Math.abs(tx.credit),
      desc,
    });
  }

  // Greedy cluster: group credits within 2.5% of seed amount
  const unused = credits
    .filter((c) => c.amount >= 20_000)
    .sort((a, b) => b.amount - a.amount);
  const groups: Credit[][] = [];
  while (unused.length) {
    const seed = unused.shift()!;
    const group = [seed];
    for (let i = unused.length - 1; i >= 0; i--) {
      const c = unused[i];
      if (Math.abs(c.amount - seed.amount) / seed.amount <= 0.025) {
        group.push(c);
        unused.splice(i, 1);
      }
    }
    groups.push(group);
  }

  const clusters: IncomeCluster[] = [];
  for (const list of groups) {
    const months = [...new Set(list.map((c) => monthKey(c.date)))].sort();
    if (months.length < 2) continue;

    const amounts = list.map((c) => c.amount);
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const variance =
      amounts.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(amounts.length, 1);
    const cv = avg > 0 ? Math.sqrt(variance) / avg : 1;
    if (cv > 0.15) continue; // too variable for payroll-like income

    const days = list.map((c) => dayOfMonth(c.date));
    const dayMode = mode(days);
    const dayConsistency =
      dayMode == null
        ? 0
        : days.filter((d) => Math.abs(d - dayMode) <= 3).length / days.length;

    const keywordHits = list.filter((c) => isSalary(c.desc)).length;
    const benefitHits = list.filter((c) => isBenefit(c.desc)).length;

    let label: IncomeCluster["label"] = "suspected_recurring_income";
    let confidence = 0.55 + months.length * 0.08 + dayConsistency * 0.15;
    if (keywordHits >= 2) {
      label = "confirmed_salary";
      confidence = Math.max(
        confidence,
        list.reduce((m, c) => Math.max(m, salaryConfidence(c.desc).confidence), 0.7),
      );
    } else if (benefitHits >= 2 && keywordHits === 0) {
      label = "benefit";
      confidence = 0.65;
    }

    confidence = Math.min(0.95, round2(confidence));
    clusters.push({
      amount: round2(avg),
      count: list.length,
      months,
      day_of_month_mode: dayMode,
      total: round2(list.reduce((a, c) => a + c.amount, 0)),
      confidence,
      label,
    });
  }

  return clusters.sort((a, b) => b.total - a.total);
}
