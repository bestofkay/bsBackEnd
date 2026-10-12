/**
 * Amount normalization with DECIMAL-safe parsing.
 * Supports EU/US separators, currency prefixes, DR/CR, parentheses.
 */

export type AmountSignHint = "debit" | "credit" | null;

export type ParsedAmount = {
  /** Absolute magnitude as a finite number (2dp rounded). */
  value: number;
  /** Signed value when parentheses / leading minus imply sign. */
  signed: number;
  sign_hint: AmountSignHint;
  raw: string;
};

const CURRENCY_PREFIX =
  /^(NGN|USD|EUR|GBP|CAD|ZAR|GHS|KES|XOF|XAF|₦|\$|£|€)\s*/i;

function detectSeparatorStyle(digits: string): "us" | "eu" | "space" | "plain" {
  const hasComma = digits.includes(",");
  const hasDot = digits.includes(".");
  const hasSpace = /\d\s+\d/.test(digits);

  if (hasComma && hasDot) {
    // Last separator is decimal
    return digits.lastIndexOf(",") > digits.lastIndexOf(".") ? "eu" : "us";
  }
  if (hasComma && !hasDot) {
    // 50,000 or 50,00 → if exactly 3 digits after last comma → thousands; 2 → decimal EU-ish
    const parts = digits.split(",");
    const last = parts[parts.length - 1] ?? "";
    if (parts.length === 2 && last.length <= 2) return "eu";
    return "us";
  }
  if (hasDot && !hasComma) {
    const parts = digits.split(".");
    const last = parts[parts.length - 1] ?? "";
    if (parts.length === 2 && last.length <= 2) return "us";
    if (parts.length > 2) return "eu"; // 50.000.00 rare; treat dots as thousands
    // Single dot with 3 fraction digits could be thousands (EU without decimals)
    if (parts.length === 2 && last.length === 3) return "eu";
    return "us";
  }
  if (hasSpace) return "space";
  return "plain";
}

function toCanonicalNumber(digits: string, style: ReturnType<typeof detectSeparatorStyle>): number | null {
  let normalized = digits.replace(/\s+/g, "");
  switch (style) {
    case "eu":
      normalized = normalized.replace(/\./g, "").replace(",", ".");
      break;
    case "us":
      normalized = normalized.replace(/,/g, "");
      break;
    case "space":
      normalized = normalized.replace(/\s+/g, "");
      break;
    default:
      break;
  }
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Parse a money token into an absolute value + optional debit/credit hint.
 */
export function parseAmount(raw: string | null | undefined): ParsedAmount | null {
  if (raw == null) return null;
  let text = String(raw).trim();
  if (!text) return null;

  let sign_hint: AmountSignHint = null;
  let negative = false;

  // DR/CR suffixes or prefixes
  if (/\bDR\b/i.test(text) || /\bDEBIT\b/i.test(text)) sign_hint = "debit";
  if (/\bCR\b/i.test(text) || /\bCREDIT\b/i.test(text)) sign_hint = "credit";

  text = text.replace(/\b(DR|CR|DEBIT|CREDIT)\b/gi, "").trim();

  // Parentheses → negative / debit
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    if (sign_hint == null) sign_hint = "debit";
    text = text.slice(1, -1).trim();
  }

  if (text.startsWith("+")) {
    text = text.slice(1).trim();
    if (sign_hint == null) sign_hint = "credit";
  } else if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1).trim();
    if (sign_hint == null) sign_hint = "debit";
  }

  // Explicit DR/CR force signed direction
  if (sign_hint === "debit") negative = true;
  if (sign_hint === "credit") negative = false;

  text = text.replace(CURRENCY_PREFIX, "").trim();
  // Strip remaining currency codes/symbols inside
  text = text.replace(/[₦$£€]/g, "").replace(/\b(NGN|USD|EUR|GBP)\b/gi, "").trim();

  if (!text) return null;

  // Must contain a digit
  if (!/\d/.test(text)) return null;
  // Reject pure dates mistaken as amounts (e.g. 12/09/2026)
  if (/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(text)) return null;

  const style = detectSeparatorStyle(text);
  const value = toCanonicalNumber(text, style);
  if (value == null) return null;

  const abs = Math.abs(value);
  const signed = negative ? -abs : abs;
  return { value: abs, signed, sign_hint, raw: String(raw) };
}

export function looksLikeAmount(raw: string): boolean {
  return parseAmount(raw) != null;
}

/**
 * Normalize debit/credit/amount triad without inventing missing sides.
 * debit → negative amount; credit → positive amount.
 */
export function normalizeDebitCreditAmount(input: {
  debit?: string | number | null;
  credit?: string | number | null;
  amount?: string | number | null;
}): {
  debit: number | null;
  credit: number | null;
  amount: number | null;
} {
  const debitParsed =
    typeof input.debit === "number"
      ? { value: Math.abs(input.debit), signed: -Math.abs(input.debit), sign_hint: "debit" as const, raw: String(input.debit) }
      : parseAmount(input.debit == null ? null : String(input.debit));
  const creditParsed =
    typeof input.credit === "number"
      ? { value: Math.abs(input.credit), signed: Math.abs(input.credit), sign_hint: "credit" as const, raw: String(input.credit) }
      : parseAmount(input.credit == null ? null : String(input.credit));
  const amountParsed =
    typeof input.amount === "number"
      ? {
          value: Math.abs(input.amount),
          signed: input.amount,
          sign_hint:
            input.amount < 0 ? ("debit" as const) : input.amount > 0 ? ("credit" as const) : null,
          raw: String(input.amount),
        }
      : parseAmount(input.amount == null ? null : String(input.amount));

  let debit: number | null = null;
  let credit: number | null = null;
  let amount: number | null = null;

  // Number inputs are already column-typed — keep side. String tokens may carry an
  // explicit sign (Access Bank puts reversals as "-9,000,000.00" in Debit).
  if (typeof input.debit === "number") {
    if (input.debit !== 0) debit = Math.abs(input.debit);
  } else if (debitParsed && debitParsed.value !== 0) {
    if (debitParsed.signed < 0) credit = debitParsed.value;
    else debit = debitParsed.value;
  }

  if (typeof input.credit === "number") {
    if (input.credit !== 0) credit = Math.abs(input.credit);
  } else if (creditParsed && creditParsed.value !== 0) {
    if (creditParsed.signed < 0) debit = creditParsed.value;
    else credit = creditParsed.value;
  }

  // Empty debit/credit cells that parsed as 0 stay null (don't invent zeros)
  if (debitParsed && debitParsed.value === 0 && !String(input.debit ?? "").trim()) {
    debit = null;
  }
  if (creditParsed && creditParsed.value === 0 && !String(input.credit ?? "").trim()) {
    credit = null;
  }

  if (amountParsed) {
    if (amountParsed.sign_hint === "debit") {
      amount = -amountParsed.value;
      if (debit == null) debit = amountParsed.value;
    } else if (amountParsed.sign_hint === "credit") {
      amount = amountParsed.value;
      if (credit == null) credit = amountParsed.value;
    } else {
      amount = amountParsed.signed;
      if (debit == null && credit == null) {
        if (amountParsed.signed < 0) debit = amountParsed.value;
        else if (amountParsed.signed > 0) credit = amountParsed.value;
      }
    }
  } else if (debit != null && credit == null) {
    amount = -debit;
  } else if (credit != null && debit == null) {
    amount = credit;
  } else if (debit != null && credit != null) {
    // Both present — amount is credit - debit
    amount = credit - debit;
  }

  return { debit, credit, amount };
}
