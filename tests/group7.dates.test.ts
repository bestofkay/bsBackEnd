/**
 * Group 7 — comprehensive date parsing regression.
 * Ambiguous numeric dates prefer day-first and MUST be flagged ambiguous.
 */

import { describe, expect, it } from "vitest";
import {
  extractDateFromText,
  looksLikeDate,
  normalizeDate,
  parseDate,
} from "../src/modules/normalization/dates.js";

describe("Group 7 date parsing", () => {
  it("parses DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, YYYY-MM-DD", () => {
    expect(parseDate("15/09/2026")?.iso).toBe("2026-09-15");
    expect(parseDate("15-09-2026")?.iso).toBe("2026-09-15");
    expect(parseDate("15.09.2026")?.iso).toBe("2026-09-15");
    expect(parseDate("2026-09-15")?.iso).toBe("2026-09-15");
    expect(parseDate("15/09/2026")?.ambiguous).toBe(false);
  });

  it("parses DD MMM YYYY and MMM DD, YYYY", () => {
    expect(parseDate("15 Sep 2026")?.iso).toBe("2026-09-15");
    expect(parseDate("15-Sep-2026")?.iso).toBe("2026-09-15");
    expect(parseDate("15 September 2026")?.iso).toBe("2026-09-15");
    expect(parseDate("Sep 15, 2026")?.iso).toBe("2026-09-15");
    expect(parseDate("September 15 2026")?.iso).toBe("2026-09-15");
  });

  it("handles leading / missing zeros", () => {
    expect(normalizeDate("01/09/2026")).toBe("2026-09-01");
    expect(normalizeDate("1/9/2026")).toBe("2026-09-01");
    expect(normalizeDate("2026-9-1")).toBe("2026-09-01");
  });

  it("does NOT interpret 01/09/2026 as January 9 without MDY context", () => {
    const parsed = parseDate("01/09/2026");
    expect(parsed?.iso).toBe("2026-09-01"); // day-first preference
    expect(parsed?.ambiguous).toBe(true); // both parts ≤ 12
    expect(parsed?.iso).not.toBe("2026-01-09");
  });

  it("resolves unambiguous day>12 and month>12 cases", () => {
    expect(parseDate("13/02/2026")?.iso).toBe("2026-02-13");
    expect(parseDate("13/02/2026")?.ambiguous).toBe(false);
    expect(parseDate("02/13/2026")?.iso).toBe("2026-02-13");
    expect(parseDate("02/13/2026")?.ambiguous).toBe(false);
  });

  it("rejects invalid and impossible dates", () => {
    expect(parseDate("32/01/2026")).toBeNull();
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("00/01/2026")).toBeNull();
    expect(parseDate("99/99/99")).toBeNull();
    expect(parseDate("")).toBeNull();
    expect(parseDate(null)).toBeNull();
    expect(looksLikeDate("not-a-date")).toBe(false);
  });

  it("expands 2-digit years conservatively", () => {
    expect(parseDate("15/01/26")?.iso).toBe("2026-01-15");
    expect(parseDate("15/01/99")?.iso).toBe("1999-01-15");
  });

  it("extracts dates from free-text lines", () => {
    expect(extractDateFromText("Posted 15/09/2026 TRANSFER")?.iso).toBe("2026-09-15");
    expect(extractDateFromText("Value date 2026-09-15 salary")?.iso).toBe("2026-09-15");
    expect(extractDateFromText("15 Sep 2026 ONLINE PAYMENT")?.iso).toBe("2026-09-15");
  });
});
