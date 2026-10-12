/**
 * Group 7 — comprehensive money / amount parsing regression.
 */

import { describe, expect, it } from "vitest";
import {
  looksLikeAmount,
  normalizeDebitCreditAmount,
  parseAmount,
} from "../src/modules/normalization/amounts.js";

describe("Group 7 money parsing", () => {
  it("parses US, EU, space separators and currency markers", () => {
    expect(parseAmount("50,000.00")?.value).toBe(50000);
    expect(parseAmount("50.000,00")?.value).toBe(50000);
    expect(parseAmount("50 000.00")?.value).toBe(50000);
    expect(parseAmount("₦50,000.00")?.value).toBe(50000);
    expect(parseAmount("NGN 50,000.00")?.value).toBe(50000);
    expect(parseAmount("$1,234.56")?.value).toBe(1234.56);
    expect(parseAmount("EUR 99.50")?.value).toBe(99.5);
  });

  it("parses negatives, parentheses, DR/CR, DEBIT/CREDIT", () => {
    expect(parseAmount("-50,000.00")?.signed).toBe(-50000);
    expect(parseAmount("-50,000.00")?.sign_hint).toBe("debit");
    expect(parseAmount("(50,000.00)")?.signed).toBe(-50000);
    expect(parseAmount("50,000 DR")?.sign_hint).toBe("debit");
    expect(parseAmount("50,000 CR")?.sign_hint).toBe("credit");
    expect(parseAmount("50,000 DEBIT")?.sign_hint).toBe("debit");
    expect(parseAmount("CREDIT 2500.00")?.sign_hint).toBe("credit");
    expect(parseAmount("+100.00")?.sign_hint).toBe("credit");
    expect(parseAmount("+100.00")?.signed).toBe(100);
  });

  it("handles blank, zero, malformed, date-like, and large amounts", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount("   ")).toBeNull();
    expect(parseAmount("0")?.value).toBe(0);
    expect(parseAmount("0.00")?.value).toBe(0);
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("12/09/2026")).toBeNull(); // never treat dates as money
    expect(looksLikeAmount("12/09/2026")).toBe(false);
    expect(parseAmount("999999999.99")?.value).toBe(999999999.99);
    expect(parseAmount("1.234")?.value).toBe(1234); // 3dp after dot → EU thousands
  });

  it("rounds to 2 decimal places without inventing values", () => {
    // 4+ fraction digits → decimal (not EU thousands)
    expect(parseAmount("10.1255")?.value).toBe(10.13);
    expect(parseAmount("10.1211")?.value).toBe(10.12);
    // Classic EU thousands with 3 digits after dot
    expect(parseAmount("1.234")?.value).toBe(1234);
  });

  it("normalizes debit/credit/amount triad exactly", () => {
    expect(normalizeDebitCreditAmount({ debit: "50,000.00", credit: "" })).toEqual({
      debit: 50000,
      credit: null,
      amount: -50000,
    });
    expect(normalizeDebitCreditAmount({ credit: "50,000.00" })).toEqual({
      debit: null,
      credit: 50000,
      amount: 50000,
    });
    expect(normalizeDebitCreditAmount({ amount: "(50,000.00)" })).toEqual({
      debit: 50000,
      credit: null,
      amount: -50000,
    });
    expect(normalizeDebitCreditAmount({ debit: 100, credit: 40 })).toEqual({
      debit: 100,
      credit: 40,
      amount: -60,
    });
    expect(normalizeDebitCreditAmount({})).toEqual({
      debit: null,
      credit: null,
      amount: null,
    });
  });

  it("keeps empty debit/credit cells as null (does not invent zero)", () => {
    expect(normalizeDebitCreditAmount({ debit: "", credit: "" })).toEqual({
      debit: null,
      credit: null,
      amount: null,
    });
  });

  it("flips signed debit-column reversals to credit", () => {
    expect(normalizeDebitCreditAmount({ debit: "-9,000,000.00", credit: "-" })).toEqual({
      debit: null,
      credit: 9_000_000,
      amount: 9_000_000,
    });
    expect(normalizeDebitCreditAmount({ debit: "-", credit: "-50.00" })).toEqual({
      debit: 50,
      credit: null,
      amount: -50,
    });
  });
});
