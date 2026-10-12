/**
 * Conservative transaction type classification from narration.
 * Uncertain cases → UNKNOWN (never forced).
 */

import type { TransactionType } from "../../contracts/index.js";

type Rule = { type: TransactionType; patterns: RegExp[]; minScore?: number };

const RULES: Rule[] = [
  { type: "REVERSAL", patterns: [/\breversal\b/i, /\breversed\b/i, /\breversal\b/i] },
  { type: "REFUND", patterns: [/\brefund\b/i, /\bchargeback\b/i] },
  { type: "SALARY", patterns: [/\bsalary\b/i, /\bppayroll\b/i, /\bwages\b/i] },
  { type: "INTEREST", patterns: [/\binterest\b/i] },
  {
    type: "BANK_CHARGE",
    patterns: [/\bbank charge\b/i, /\bservice charge\b/i, /\bfee\b/i, /\bcommission\b/i, /\bvAT\b/i],
  },
  { type: "ATM", patterns: [/\batm\b/i] },
  { type: "POS", patterns: [/\bpos\b/i, /\bpoint of sale\b/i] },
  {
    type: "CARD_PAYMENT",
    patterns: [/\bcard payment\b/i, /\bvisa\b/i, /\bmastercard\b/i, /\bdebit card\b/i],
  },
  {
    type: "CASH_WITHDRAWAL",
    patterns: [/\bcash withdrawal\b/i, /\bwithdrawal\b/i, /\bcash wd\b/i],
  },
  { type: "CASH_DEPOSIT", patterns: [/\bcash deposit\b/i, /\bdeposit cash\b/i] },
  { type: "CHEQUE", patterns: [/\bcheque\b/i, /\bcheck\b/i, /\bchq\b/i] },
  {
    type: "MOBILE_PAYMENT",
    patterns: [/\bmobile\b/i, /\bussd\b/i, /\btransfer.*phone\b/i, /\bopay\b/i, /\bpalm.?pay\b/i],
  },
  {
    type: "ONLINE_PAYMENT",
    patterns: [/\bonline payment\b/i, /\bweb pay\b/i, /\binternet banking\b/i, /\be-?payment\b/i],
  },
  {
    type: "DIRECT_DEBIT",
    patterns: [/\bdirect debit\b/i, /\bdd\b/i, /\bstanding order\b/i],
  },
  {
    type: "DIRECT_CREDIT",
    patterns: [/\bdirect credit\b/i, /\bdc\b/i],
  },
  {
    type: "TRANSFER",
    patterns: [
      /\btransfer\b/i,
      /\btrf\b/i,
      /\bnb\b/i,
      /\bneft\b/i,
      /\brtgs\b/i,
      /\bfip\b/i,
      /\binflow\b/i,
      /\boutflow\b/i,
    ],
  },
];

export function classifyTransactionType(description: string | null | undefined): TransactionType {
  if (!description || !description.trim()) return "UNKNOWN";
  const text = description.trim();

  const hits: Array<{ type: TransactionType; score: number }> = [];
  for (const rule of RULES) {
    let score = 0;
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) score += 1;
    }
    if (score > 0) hits.push({ type: rule.type, score });
  }

  if (hits.length === 0) return "UNKNOWN";
  hits.sort((a, b) => b.score - a.score);

  // If top two are tied across different types, stay UNKNOWN unless clear winner.
  if (hits.length > 1 && hits[0].score === hits[1].score && hits[0].type !== hits[1].type) {
    // Prefer more specific types already ordered above TRANSFER
    if (hits[0].type === "TRANSFER") return "UNKNOWN";
  }

  return hits[0].type;
}
