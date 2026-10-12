import { describe, expect, it } from "vitest";
import {
  normalizeDate,
  parseDate,
  parseAmount,
  normalizeDebitCreditAmount,
  classifyTransactionType,
} from "../src/modules/normalization/index.js";

describe("date normalization", () => {
  it("normalizes ISO and day-month-year formats", () => {
    expect(normalizeDate("2024-01-15")).toBe("2024-01-15");
    expect(normalizeDate("15/01/2024")).toBe("2024-01-15");
    expect(normalizeDate("15-Jan-2024")).toBe("2024-01-15");
    expect(normalizeDate("15 January 2024")).toBe("2024-01-15");
  });

  it("resolves unambiguous numeric dates and marks ambiguous ones", () => {
    expect(parseDate("13/02/2024")?.iso).toBe("2024-02-13");
    expect(parseDate("02/13/2024")?.iso).toBe("2024-02-13");
    const ambiguous = parseDate("01/02/2024");
    expect(ambiguous?.iso).toBe("2024-02-01"); // day-first preference
    expect(ambiguous?.ambiguous).toBe(true);
  });

  it("does not invent invalid dates", () => {
    expect(normalizeDate("99/99/99")).toBeNull();
    expect(normalizeDate("not a date")).toBeNull();
    expect(normalizeDate(null)).toBeNull();
  });
});

describe("amount normalization", () => {
  it("parses US/EU separators and currency prefixes", () => {
    expect(parseAmount("50,000.00")?.value).toBe(50000);
    expect(parseAmount("50.000,00")?.value).toBe(50000);
    expect(parseAmount("₦50,000.00")?.value).toBe(50000);
    expect(parseAmount("NGN 50,000.00")?.value).toBe(50000);
    expect(parseAmount("50 000.00")?.value).toBe(50000);
  });

  it("handles DR/CR and parentheses", () => {
    expect(parseAmount("50,000 DR")?.sign_hint).toBe("debit");
    expect(parseAmount("50,000 CR")?.sign_hint).toBe("credit");
    expect(parseAmount("(50,000.00)")?.signed).toBe(-50000);
  });

  it("normalizes debit/credit/amount triad without inventing zeros", () => {
    expect(normalizeDebitCreditAmount({ debit: "50,000.00", credit: "" })).toEqual({
      debit: 50000,
      credit: null,
      amount: -50000,
    });
    expect(normalizeDebitCreditAmount({ credit: "2,500.00" })).toEqual({
      debit: null,
      credit: 2500,
      amount: 2500,
    });
    expect(normalizeDebitCreditAmount({ amount: "50,000 DR" })).toEqual({
      debit: 50000,
      credit: null,
      amount: -50000,
    });
    expect(normalizeDebitCreditAmount({ amount: "(100.00)" }).amount).toBe(-100);
    expect(normalizeDebitCreditAmount({}).amount).toBeNull();
  });
});

describe("transaction type classification", () => {
  it("classifies clear narrations conservatively", () => {
    expect(classifyTransactionType("TRANSFER TO JOHN DOE")).toBe("TRANSFER");
    expect(classifyTransactionType("ATM WITHDRAWAL")).toBe("ATM");
    expect(classifyTransactionType("POS PURCHASE COFFEE")).toBe("POS");
    expect(classifyTransactionType("SALARY PAYMENT")).toBe("SALARY");
    expect(classifyTransactionType("BANK CHARGE VAT")).toBe("BANK_CHARGE");
    expect(classifyTransactionType("INTEREST CREDIT")).toBe("INTEREST");
  });

  it("returns UNKNOWN when uncertain", () => {
    expect(classifyTransactionType("MISC ADJUSTMENT XYZ")).toBe("UNKNOWN");
    expect(classifyTransactionType(null)).toBe("UNKNOWN");
    expect(classifyTransactionType("")).toBe("UNKNOWN");
  });
});
