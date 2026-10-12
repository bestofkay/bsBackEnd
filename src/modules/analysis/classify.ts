import { BET_HOUSES, LENDERS, type AnalysisCategory } from "./patterns.js";

export type ClassifiedNarration = {
  category: AnalysisCategory;
  confidence: number;
  reasons: string[];
};

export function normalizeDesc(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[\r\n]+/g, " ")
    .replace(/[|_/\\-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasToken(text: string, tokens: string[]): boolean {
  const words = new Set(text.split(" "));
  return tokens.some((t) => {
    if (t.includes(" ")) return text.includes(t);
    return words.has(t);
  });
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((n) => text.includes(n));
}

export function salaryConfidence(desc: string): { hit: boolean; confidence: number; reasons: string[] } {
  const t = normalizeDesc(desc);
  const reasons: string[] = [];
  if (hasAny(t, ["salary advance", "saladv", "salad", "payday loan", "loan", "reversal", "reverse"])) {
    return { hit: false, confidence: 0, reasons: ["excluded_loan_or_reversal"] };
  }
  let confidence = 0;
  if (hasAny(t, ["salary", "staff salary", "net pay", "payroll", "remuneration"])) {
    confidence = 0.92;
    reasons.push("explicit_salary_keyword");
  } else if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)sal\b/.test(t) || /\bsal(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/.test(t)) {
    confidence = 0.85;
    reasons.push("month_salary_token");
  } else if (/\bsalary\b/.test(t) || /\bremunerat/.test(t)) {
    confidence = 0.88;
    reasons.push("salary_stem");
  } else if (/\bsal\b/.test(t) && !hasAny(t, ["sale", "sales", "salon"])) {
    confidence = 0.55;
    reasons.push("ambiguous_sal_token");
  }
  return { hit: confidence >= 0.55, confidence, reasons };
}

export function isSalary(desc: string): boolean {
  return salaryConfidence(desc).hit;
}

export function isBenefit(desc: string): boolean {
  const t = normalizeDesc(desc);
  return hasAny(t, [
    "bonus",
    "allowance",
    "incentive",
    "housing allow",
    "transport allow",
    "leave",
    "arrears",
    "benefit",
    "dividend",
    "13th",
    "furniture",
  ]);
}

export function loanConfidence(desc: string): {
  hit: boolean;
  confidence: number;
  side: "disbursement" | "repayment" | "unknown";
  lender: string | null;
  reasons: string[];
} {
  const t = normalizeDesc(desc);
  const reasons: string[] = [];
  if (hasAny(t, ["procure", "procurement", "logistics"])) {
    return { hit: false, confidence: 0, side: "unknown", lender: null, reasons: ["excluded_procurement"] };
  }
  const lender = matchLender(t);
  let confidence = 0;
  let side: "disbursement" | "repayment" | "unknown" = "unknown";

  if (lender) {
    confidence = 0.9;
    reasons.push(`lender:${lender}`);
  }
  if (hasAny(t, ["repayment", "repymt", "rpymt", "rpmt", "installment", "recoup"])) {
    confidence = Math.max(confidence, 0.88);
    side = "repayment";
    reasons.push("repayment_keyword");
  }
  if (hasAny(t, ["disburse", "disbursement", "loan credit", "loan payout"])) {
    confidence = Math.max(confidence, 0.9);
    side = "disbursement";
    reasons.push("disbursement_keyword");
  }
  if (hasAny(t, ["loan", "microfinance", "mfb", "obligor", "payday", "saladv", "cooperative", "coop", "principal"])) {
    confidence = Math.max(confidence, lender ? 0.9 : 0.75);
    reasons.push("loan_keyword");
  }
  if (confidence > 0 && side === "unknown") {
    // side inferred later from credit/debit by caller
    reasons.push("side_unspecified");
  }
  return { hit: confidence >= 0.7, confidence, side, lender, reasons };
}

export function isLoan(desc: string): boolean {
  return loanConfidence(desc).hit;
}

function brandBoundaryMatch(text: string, brand: string): boolean {
  const escaped = brand.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Allow glued brands (bet9jabet9ja) and domains (sportybet.com)
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(text);
}

export function gamblingConfidence(desc: string): { hit: boolean; confidence: number; reasons: string[] } {
  const t = normalizeDesc(desc);
  // Never treat bare "bet" inside names (e.g. Elizabeth) as gambling.
  const house = BET_HOUSES.find((b) => b.length >= 4 && brandBoundaryMatch(t, b));
  if (house) return { hit: true, confidence: 0.95, reasons: [`bet_house:${house}`] };
  // Glued brand forms without separators
  const glued = BET_HOUSES.find((b) => b.length >= 5 && t.includes(b.toLowerCase()));
  if (glued) return { hit: true, confidence: 0.9, reasons: [`bet_house_glued:${glued}`] };
  if (hasToken(t, ["betting", "wager", "bookie", "bookmaker"])) {
    return { hit: true, confidence: 0.8, reasons: ["betting_keyword"] };
  }
  return { hit: false, confidence: 0, reasons: [] };
}
export function isGambling(desc: string): boolean {
  return gamblingConfidence(desc).hit;
}

export function isReligion(desc: string): boolean {
  const t = normalizeDesc(desc);
  return hasAny(t, [
    "church",
    "mosque",
    "offering",
    "tithe",
    "pastor",
    "ministries",
    "rccg",
    "winners",
    "redeem",
    "daystar",
    "dunamis",
    "christ embassy",
    "mfm",
    "deeper life",
  ]);
}

export function isAtm(desc: string): boolean {
  return /\batm\b/i.test(desc ?? "");
}

export function isPos(desc: string): boolean {
  const t = normalizeDesc(desc);
  return hasToken(t, ["pos"]) || t.includes("point of sale");
}

export function isTransfer(desc: string): boolean {
  const t = normalizeDesc(desc);
  if (hasAny(t, ["airtime", "recharge", "topup", "top up", "salary", "loan", "reversal", "billpay"])) {
    return false;
  }
  return hasAny(t, ["transfer", "trf", "nip", "nibss", "mobile", "mbanking", "inward", "outward"]);
}

export function isAirtime(desc: string): boolean {
  const t = normalizeDesc(desc);
  return hasAny(t, ["airtime", "recharge", "topup", "top up", "mtn", "glo", "airtel", "etisalat", "9mobile"]);
}

export function isBankCharge(desc: string): boolean {
  const t = normalizeDesc(desc);
  return hasAny(t, [
    "vat",
    "commission",
    "charge",
    "fee",
    "stamp duty",
    "sms alert",
    "cot",
    "account maintenance",
  ]);
}

export function isCheque(desc: string): boolean {
  const t = normalizeDesc(desc);
  return hasAny(t, ["chq", "cheque", "clearing", "clg"]);
}

export function isEntertainment(desc: string): boolean {
  const t = normalizeDesc(desc);
  return hasAny(t, ["club", "bar", "casino", "lounge", "cinema", "quilox"]);
}

export function isInvestment(desc: string): boolean {
  const t = normalizeDesc(desc);
  return hasAny(t, ["invest", "investment", "mutual fund", "treasury bill", "t bill"]);
}

export function isSchoolFees(desc: string): boolean {
  const t = normalizeDesc(desc);
  return hasAny(t, ["school fees", "tuition", "nursery", "secondary", "primary school"]);
}

export function isReversal(desc: string): boolean {
  const t = normalizeDesc(desc);
  return hasAny(t, ["reversal", "reverse", "reversed"]);
}

export function isCableTv(desc: string): boolean {
  const t = normalizeDesc(desc);
  return hasAny(t, ["dstv", "gotv", "startimes", "multichoice", "showmax"]);
}

export function isElectricity(desc: string): boolean {
  const t = normalizeDesc(desc);
  return hasAny(t, ["phcn", "buypower", "ikeja electric", "aedc", "eedc", "electricity", "prepaid"]);
}

/** Brands that are also common English words — require multi-token alias only. */
const AMBIGUOUS_LENDER_BRANDS = new Set(["Branch", "Carbon", "Paylater"]);

export function matchLender(desc: string): string | null {
  const t = normalizeDesc(desc);
  const words = t.split(" ");
  for (const group of LENDERS) {
    const brand = group[0];
    const ambiguous = AMBIGUOUS_LENDER_BRANDS.has(brand);
    for (const alias of group) {
      const a = alias.toLowerCase();
      if (a.includes(" ")) {
        if (t.includes(a)) return brand;
        continue;
      }
      if (ambiguous) continue; // only multi-word aliases for ambiguous brands
      if (a.length >= 5 && words.includes(a)) return brand;
      if (a.length >= 7 && t.includes(a)) return brand;
    }
  }
  return null;
}export function classifyDescription(desc: string | null | undefined): AnalysisCategory {
  return classifyNarration(desc).category;
}

export function classifyNarration(desc: string | null | undefined): ClassifiedNarration {
  const raw = desc ?? "";
  if (isReversal(raw)) return { category: "reversal", confidence: 0.95, reasons: ["reversal"] };
  const gamble = gamblingConfidence(raw);
  if (gamble.hit && gamble.confidence >= 0.6) {
    return { category: "gambling", confidence: gamble.confidence, reasons: gamble.reasons };
  }
  const sal = salaryConfidence(raw);
  if (sal.hit) return { category: "salary", confidence: sal.confidence, reasons: sal.reasons };
  const loan = loanConfidence(raw);
  if (loan.hit) return { category: "loan", confidence: loan.confidence, reasons: loan.reasons };
  if (isBankCharge(raw)) return { category: "bank_charge", confidence: 0.9, reasons: ["charge"] };
  if (isAtm(raw)) return { category: "atm", confidence: 0.9, reasons: ["atm"] };
  if (isPos(raw)) return { category: "pos", confidence: 0.85, reasons: ["pos"] };
  if (isAirtime(raw)) return { category: "airtime", confidence: 0.88, reasons: ["airtime"] };
  if (isCableTv(raw)) return { category: "cable_tv", confidence: 0.9, reasons: ["cable"] };
  if (isElectricity(raw)) return { category: "electricity", confidence: 0.88, reasons: ["power"] };
  if (isReligion(raw)) return { category: "religion", confidence: 0.8, reasons: ["religion"] };
  if (isEntertainment(raw)) return { category: "entertainment", confidence: 0.75, reasons: ["entertainment"] };
  if (isInvestment(raw)) return { category: "investment", confidence: 0.8, reasons: ["investment"] };
  if (isSchoolFees(raw)) return { category: "school_fees", confidence: 0.8, reasons: ["school"] };
  if (isCheque(raw)) return { category: "cheque", confidence: 0.85, reasons: ["cheque"] };
  if (isTransfer(raw)) return { category: "transfer", confidence: 0.7, reasons: ["transfer"] };
  if (/\bcash\b|\bcsh\b|\bwtdl\b|\bdeposit\b|\bwithdrawal\b/i.test(raw)) {
    return { category: "cash", confidence: 0.65, reasons: ["cash"] };
  }
  if (/\brent\b/i.test(raw)) return { category: "rent", confidence: 0.75, reasons: ["rent"] };
  if (/\binsurance\b/i.test(raw)) return { category: "insurance", confidence: 0.8, reasons: ["insurance"] };
  if (/\bsubscription\b/i.test(raw)) return { category: "subscription", confidence: 0.7, reasons: ["subscription"] };
  if (/\bbill\b/i.test(raw)) return { category: "bills", confidence: 0.65, reasons: ["bills"] };
  if (/\bwater\b/i.test(raw)) return { category: "water", confidence: 0.7, reasons: ["water"] };
  return { category: "other", confidence: 0.35, reasons: ["unclassified"] };
}

/**
 * Token-overlap name match with length-weighted scoring and common Nigerian name noise filters.
 */
export function nameMatchScore(accountName: string | null | undefined, description: string): number {
  if (!accountName) return 0;
  const stop = new Set(["the", "and", "for", "from", "with", "ltd", "limited", "nig", "nigeria"]);
  const nameParts = normalizeDesc(accountName)
    .split(" ")
    .filter((p) => p.length > 2 && !stop.has(p));
  if (!nameParts.length) return 0;
  const desc = normalizeDesc(description);
  let weightedHits = 0;
  let weightTotal = 0;
  for (const p of nameParts) {
    const w = p.length >= 6 ? 1.4 : 1;
    weightTotal += w;
    if (desc.includes(p)) weightedHits += w;
  }
  return Math.round((weightedHits / weightTotal) * 100);
}
