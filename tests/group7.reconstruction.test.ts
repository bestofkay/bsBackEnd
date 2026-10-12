/**
 * Group 7 — reconstruction, multipage continuation, balance & duplicate edges.
 */

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  reconstructFromLines,
  reconstructFromTable,
  isNoiseLine,
} from "../src/modules/transactions/index.js";
import type { IntermediateTable } from "../src/modules/extraction/types.js";
import { buildCanonicalTransaction } from "../src/modules/transactions/index.js";
import {
  applyDuplicateFlags,
  detectDuplicates,
} from "../src/modules/duplicates/index.js";
import {
  reconcileBalances,
} from "../src/modules/reconciliation/index.js";
import {
  validateBalanceProgression,
  validateStatement,
} from "../src/modules/validation/index.js";
import {
  scoreTransactionConfidenceDetailed,
  buildQualitySummary,
  scoreAllTransactions,
} from "../src/modules/confidence/index.js";
import type { Transaction } from "../src/contracts/index.js";

function tableFromRows(
  headers: Array<{ raw: string; field: IntermediateTable["headers"][number]["mapped_field"] }>,
  data: string[][],
): IntermediateTable {
  const headerRow = {
    id: randomUUID(),
    page: 1,
    row_index: 0,
    role: "header" as const,
    is_continuation: false,
    sheet: null,
    cells: headers.map((h, column) => ({
      id: randomUUID(),
      page: 1,
      row: 0,
      column,
      raw_text: h.raw,
      bbox: null,
      extraction_method: "csv" as const,
      ocr_confidence: null,
      role: "header" as const,
      mapped_field: h.field,
      sheet: null,
    })),
  };

  const rows = data.map((values, idx) => ({
    id: randomUUID(),
    page: 1,
    row_index: idx + 1,
    role: "data" as const,
    is_continuation: false,
    sheet: null,
    cells: values.map((raw_text, column) => ({
      id: randomUUID(),
      page: 1,
      row: idx + 1,
      column,
      raw_text,
      bbox: null,
      extraction_method: "csv" as const,
      ocr_confidence: null,
      role: "data" as const,
      mapped_field: headers[column]?.field ?? null,
      sheet: null,
    })),
  }));

  return {
    id: randomUUID(),
    page_start: 1,
    page_end: 1,
    sheet: null,
    headers: headers.map((h, column) => ({
      column,
      raw_text: h.raw,
      mapped_field: h.field,
    })),
    rows: [headerRow, ...rows],
    repeated_header_pages: [],
  };
}

function tx(partial: Parameters<typeof buildCanonicalTransaction>[0]): Transaction {
  return buildCanonicalTransaction(partial);
}

describe("Group 7 multi-line reconstruction", () => {
  it("merges split transfer into ONE transaction (date/desc/ref/amount)", () => {
    const txs = reconstructFromLines(
      [
        "01/09/2026",
        "TRANSFER TO JOHN",
        "ACCOUNT 123456",
        "REFERENCE ABC123",
        "50,000 DR",
      ],
      "NGN",
    );
    expect(txs).toHaveLength(1);
    expect(txs[0].transaction_date).toBe("2026-09-01");
    expect(txs[0].description).toMatch(/TRANSFER TO JOHN/i);
    expect(txs[0].description).toMatch(/ACCOUNT 123456/i);
    expect(txs[0].reference).toMatch(/ABC123/i);
    expect(txs[0].amount).toBe(-50000);
    expect(txs[0].debit).toBe(50000);
  });

  it("does not treat headers/footers/page numbers as transactions", () => {
    expect(isNoiseLine("Page 2 of 10")).toBe(true);
    expect(isNoiseLine("Date Description Debit Credit Balance")).toBe(true);
    expect(isNoiseLine("End of statement")).toBe(true);

    const txs = reconstructFromLines([
      "Page 1 of 2",
      "Demo Bank Statement",
      "Date Description Debit Credit Balance",
      "01/09/2026",
      "POS STORE A",
      "1,000.00 DR",
      "Page 2 of 2",
      "Date Description Debit Credit Balance",
      "02/09/2026",
      "POS STORE B",
      "2,000.00 DR",
      "End of statement",
    ]);
    expect(txs).toHaveLength(2);
  });

  it("keeps description numbers/dates/currency as narration, not new txs", () => {
    const txs = reconstructFromLines([
      "2026-09-01",
      "PAYMENT INVOICE 12/08/2026 FOR NGN 9,999 REF ORDER-77",
      "500.00 DR",
    ]);
    expect(txs).toHaveLength(1);
    expect(txs[0].description).toMatch(/INVOICE/);
    expect(txs[0].description).toMatch(/12\/08\/2026/);
    expect(txs[0].amount).toBe(-500);
  });

  it("supports signed amount column without separate debit/credit", () => {
    const table = tableFromRows(
      [
        { raw: "Date", field: "transaction_date" },
        { raw: "Narration", field: "description" },
        { raw: "Amount", field: "amount" },
        { raw: "Balance", field: "balance" },
      ],
      [
        ["2026-09-01", "TRANSFER OUT", "-50000.00", "950000.00"],
        ["2026-09-02", "SALARY", "250000.00", "1200000.00"],
      ],
    );
    const txs = reconstructFromTable(table, "NGN");
    expect(txs).toHaveLength(2);
    expect(txs[0].amount).toBe(-50000);
    expect(txs[1].amount).toBe(250000);
  });

  it("parses Access Bank one-line rows including signed reversals", () => {
    const txs = reconstructFromLines(
      [
        "28-APR-26 28-APR-26 Opening Balance - 0.00 445,659.09",
        "28-APR-26 28-APR-26 MOBILE TRF TO GTB/ /UZONWANNE NNEKA FRANCISCA 20,000.00 - 425,659.09",
        "28-APR-26 28-APR-26 Transfer from Bread Butik - 80,000.00 355,578.47",
        "10-JUL-26 10-JUL-26 Reversal of-MOBILE TRF TO PAY/ /JESSY ONE TOUCH ENTERPRISE -9,000,000.00 - 9,611,279.00",
        "20-SEP-26 19-SEP-26 FGN Stamp Duty for 25 txns 13/09--19/09/26 1,250.00 - -135,800.48",
      ],
      "NGN",
    );
    expect(txs).toHaveLength(4);
    expect(txs[0].debit).toBe(20000);
    expect(txs[0].balance).toBe(425659.09);
    expect(txs[1].credit).toBe(80000);
    expect(txs[2].credit).toBe(9_000_000);
    expect(txs[2].debit).toBeNull();
    expect(txs[3].debit).toBe(1250);
    expect(txs[3].balance).toBe(-135800.48);
  });
});

describe("Group 7 ledger dedupe", () => {
  it("drops consecutive exact duplicate ledger rows only", async () => {
    const { reconstructFromLines, dedupeExactLedgerTransactions } = await import(
      "../src/modules/transactions/reconstruct.js"
    );
    const lines = [
      "28-APR-26 28-APR-26 MOBILE TRF TO PAY/ /JESSY 9,000,000.00 - 611,333.00",
      "28-APR-26 28-APR-26 MOBILE TRF TO PAY/ /JESSY 9,000,000.00 - 611,333.00",
      "28-APR-26 28-APR-26 COMMISSION MOBILE TRF TO PAY/ /JESSY 50.00 - 611,283.00",
    ];
    const raw = reconstructFromLines(lines, "NGN");
    expect(raw).toHaveLength(3);
    const deduped = dedupeExactLedgerTransactions(raw);
    expect(deduped).toHaveLength(2);

    // Non-consecutive identical fingerprints must be kept (reversal cycles)
    const nonConsecutive = dedupeExactLedgerTransactions([
      raw[0],
      raw[2],
      raw[0],
    ]);
    expect(nonConsecutive).toHaveLength(3);
  });

  it("stitches pages dropping overlapping ledger prefixes", async () => {
    const { stitchPagesDroppingOverlap } = await import(
      "../src/modules/transactions/reconstruct.js"
    );
    const page1 = [
      "10-JUL-26 10-JUL-26 MOBILE TRF TO PAY/ /JESSY 4,500,000.00 - 5,111,333.00",
      "10-JUL-26 10-JUL-26 COMMISSION MOBILE TRF TO PAY/ /JESSY 50.00 - 5,111,283.00",
      "10-JUL-26 10-JUL-26 VAT MOBILE TRF TO PAY/ /JESSY 3.75 - 5,111,279.25",
    ];
    const page2 = [
      "10-JUL-26 10-JUL-26 COMMISSION MOBILE TRF TO PAY/ /JESSY 50.00 - 5,111,283.00",
      "10-JUL-26 10-JUL-26 VAT MOBILE TRF TO PAY/ /JESSY 3.75 - 5,111,279.25",
      "10-JUL-26 10-JUL-26 Transfer from Bread Butik - 80,000.00 5,191,279.25",
    ];
    const stitched = stitchPagesDroppingOverlap([page1, page2]);
    expect(stitched).toHaveLength(4);
    expect(stitched[3]).toMatch(/Transfer from Bread Butik/);
  });
});

describe("Group 7 reconciliation & running balance", () => {
  it("reports RECONCILED for exact opening + credits - debits", () => {
    const transactions = [
      tx({ transaction_date: "2026-09-01", description: "IN", credit: 100000, amount: 100000 }),
      tx({ transaction_date: "2026-09-02", description: "OUT", debit: 25000, amount: -25000 }),
    ];
    const r = reconcileBalances({
      openingBalance: 1_710_000,
      closingBalance: 1_785_000,
      transactions,
    });
    expect(r.reconciliation_status).toBe("RECONCILED");
    expect(r.difference).toBe(0);
    expect(transactions[0].amount).toBe(100000); // unchanged
  });

  it("reports MISMATCH without mutating transactions", () => {
    const transactions = [
      tx({ transaction_date: "2026-09-01", description: "IN", credit: 50000, amount: 50000 }),
    ];
    const before = structuredClone(transactions);
    const r = reconcileBalances({
      openingBalance: 1_710_000,
      closingBalance: 1_785_000,
      transactions,
    });
    expect(r.reconciliation_status).toBe("MISMATCH");
    expect(transactions).toEqual(before);
  });

  it("reports NOT_DETERMINABLE when balances missing", () => {
    const r = reconcileBalances({
      openingBalance: null,
      closingBalance: null,
      transactions: [
        tx({ transaction_date: "2026-09-01", description: "x", credit: 10, amount: 10 }),
      ],
    });
    expect(r.reconciliation_status).toBe("NOT_DETERMINABLE");
    expect(r.reconciled).toBe(false);
  });

  it("validates running balance progression for debit and credit", () => {
    const ok = [
      tx({
        transaction_date: "2026-09-01",
        description: "OUT",
        debit: 50000,
        amount: -50000,
        balance: 950000,
      }),
      tx({
        transaction_date: "2026-09-02",
        description: "IN",
        credit: 10000,
        amount: 10000,
        balance: 960000,
      }),
    ];
    expect(validateBalanceProgression(ok, 1_000_000).every((i) => i.code !== "BALANCE_MISMATCH")).toBe(
      true,
    );

    const bad = [
      tx({
        transaction_date: "2026-09-01",
        description: "OUT",
        debit: 50000,
        amount: -50000,
        balance: 970000,
      }),
    ];
    const issues = validateBalanceProgression(bad, 1_000_000);
    expect(issues.some((i) => i.code === "BALANCE_MISMATCH")).toBe(true);
    expect(bad[0].balance).toBe(970000);
  });

  it("does not fail whole statement merely because balances are absent", () => {
    const transactions = [
      tx({
        transaction_date: "2026-09-01",
        description: "POS",
        debit: 10,
        amount: -10,
        transaction_type: "POS",
      }),
    ];
    const v = validateStatement({ transactions, openingBalance: null, closingBalance: null });
    expect(v.issues.some((i) => i.code === "MISSING_BALANCE")).toBe(true);
    expect(v.is_valid).toBe(true); // missing balance is info, not error
  });
});

describe("Group 7 duplicates", () => {
  it("flags exact same-day page-overlap duplicates", () => {
    const a = {
      transaction_date: "2026-09-15",
      description: "STANDING ORDER UTILITY PAYMENT",
      amount: -12500.5,
      debit: 12500.5,
      currency: "NGN",
      reference: null as string | null,
    };
    const flagged = applyDuplicateFlags([tx(a), tx(a)], detectDuplicates([tx(a), tx(a)]));
    expect(flagged.every((t) => t.duplicate_suspected)).toBe(true);
  });

  it("does not flag recurring salary / same-day POS with different refs", () => {
    const salary = [
      tx({
        transaction_date: "2026-08-25",
        description: "SALARY PAYMENT",
        credit: 500000,
        amount: 500000,
        reference: "PAY-AUG",
      }),
      tx({
        transaction_date: "2026-09-25",
        description: "SALARY PAYMENT",
        credit: 500000,
        amount: 500000,
        reference: "PAY-SEP",
      }),
    ];
    expect(detectDuplicates(salary).candidates).toHaveLength(0);

    const pos = [
      tx({
        transaction_date: "2026-09-01",
        description: "POS COFFEE",
        debit: 1500,
        amount: -1500,
        reference: "POS-001",
      }),
      tx({
        transaction_date: "2026-09-01",
        description: "POS COFFEE",
        debit: 1500,
        amount: -1500,
        reference: "POS-002",
      }),
    ];
    expect(detectDuplicates(pos).candidates).toHaveLength(0);
  });

  it("does not delete when duplicates suspected", () => {
    const list = [
      tx({
        transaction_date: "2026-01-01",
        description: "FEE",
        debit: 100,
        amount: -100,
        reference: "F1",
      }),
      tx({
        transaction_date: "2026-01-01",
        description: "FEE",
        debit: 100,
        amount: -100,
        reference: "F1",
      }),
    ];
    expect(applyDuplicateFlags(list, detectDuplicates(list))).toHaveLength(2);
  });
});

describe("Group 7 confidence & warnings", () => {
  it("scores complete high-OCR rows higher than sparse low-OCR rows", () => {
    const high = scoreTransactionConfidenceDetailed(
      tx({
        transaction_date: "2026-09-01",
        description: "SALARY CREDIT SEPTEMBER",
        credit: 500000,
        amount: 500000,
        balance: 1500000,
        reference: "PAY",
        currency: "NGN",
        transaction_type: "SALARY",
        raw: { ocr_confidence: 0.95 },
      }),
      0,
      null,
    );
    const low = scoreTransactionConfidenceDetailed(
      tx({
        description: "x",
        raw: { ocr_confidence: 0.2 },
      }),
      1,
      null,
    );
    expect(high.confidence).toBeGreaterThan(low.confidence);
    expect(Object.keys(high.factors).length).toBeGreaterThanOrEqual(8);
  });

  it("emits machine-readable warning codes", () => {
    const incomplete = tx({ description: "incomplete" });
    const dup = {
      ...tx({
        transaction_date: "2026-09-01",
        description: "FEE",
        debit: 1,
        amount: -1,
        reference: "R",
      }),
      duplicate_suspected: true,
      duplicate_group_id: "dup_00001",
    } as Transaction;
    const lowOcr = tx({
      transaction_date: "2026-09-01",
      description: "OCR BAD",
      debit: 1,
      amount: -1,
      raw: { ocr_confidence: 0.2 },
    });
    const validation = validateStatement({
      transactions: [incomplete, dup, lowOcr],
    });
    const codes = new Set(validation.issues.map((i) => i.code));
    expect(codes.has("INCOMPLETE_TRANSACTION") || codes.has("MISSING_AMOUNT")).toBe(true);
    expect(codes.has("POSSIBLE_DUPLICATE")).toBe(true);
    expect(codes.has("OCR_LOW_CONFIDENCE")).toBe(true);
    expect(codes.has("MISSING_REFERENCE") || codes.has("MISSING_BALANCE")).toBe(true);

    const scored = scoreAllTransactions([incomplete], validation);
    const quality = buildQualitySummary({
      transactions: [incomplete],
      validation,
      duplicateCount: 1,
      scored,
    });
    expect(quality.warnings.some((w) => w.code === "LOW_CONFIDENCE_TRANSACTION")).toBe(true);
  });
});
