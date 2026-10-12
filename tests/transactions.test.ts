import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  reconstructFromLines,
  reconstructFromTable,
  reconstructTransactions,
  isNoiseLine,
  extractReference,
} from "../src/modules/transactions/index.js";
import type { IntermediateExtraction, IntermediateTable } from "../src/modules/extraction/types.js";
import { IntermediateExtractionSchema } from "../src/modules/extraction/types.js";

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

describe("noise / reference helpers", () => {
  it("ignores page footers and repeated headers", () => {
    expect(isNoiseLine("Page 2 of 10")).toBe(true);
    expect(isNoiseLine("Date Description Debit Credit Balance")).toBe(true);
    expect(isNoiseLine("End of statement")).toBe(true);
    expect(isNoiseLine("TRANSFER TO JOHN DOE")).toBe(false);
  });

  it("extracts references when present", () => {
    expect(extractReference("TRANSFER REF 839292")).toBe("839292");
    expect(extractReference("no ref here")).toBeNull();
  });
});

describe("multi-line free-form reconstruction", () => {
  it("merges date + narration + bank + ref + amounts into ONE transaction", () => {
    const txs = reconstructFromLines(
      [
        "12/09/2026",
        "TRANSFER TO JOHN DOE",
        "ACCESS BANK",
        "REF 839292",
        "50,000.00",
        "1,200,000.00",
      ],
      "NGN",
    );

    expect(txs).toHaveLength(1);
    const tx = txs[0];
    expect(tx.transaction_date).toBe("2026-09-12");
    expect(tx.description).toContain("TRANSFER TO JOHN DOE");
    expect(tx.description).toContain("ACCESS BANK");
    expect(tx.reference).toBe("839292");
    expect(tx.amount).toBe(50000); // positive when no debit hint — treated as credit magnitude path
    // First amount without sign → credit; balance is second
    expect(tx.balance).toBe(1_200_000);
    expect(tx.currency).toBe("NGN");
    expect(tx.transaction_type).toBe("TRANSFER");
  });

  it("supports missing reference and missing balance", () => {
    const txs = reconstructFromLines([
      "2024-01-02",
      "POS PURCHASE COFFEE",
      "4.50 DR",
    ]);
    expect(txs).toHaveLength(1);
    expect(txs[0].reference).toBeNull();
    expect(txs[0].balance).toBeNull();
    expect(txs[0].debit).toBe(4.5);
    expect(txs[0].amount).toBe(-4.5);
    expect(txs[0].transaction_type).toBe("POS");
  });

  it("ignores page boundaries and repeated headers between transactions", () => {
    const txs = reconstructFromLines([
      "01/02/2024",
      "SALARY PAYMENT",
      "2500.00 CR",
      "Page 1 of 2",
      "Date Description Debit Credit Balance",
      "02/02/2024",
      "ATM WITHDRAWAL",
      "200.00 DR",
      "End of statement",
    ]);
    expect(txs).toHaveLength(2);
    expect(txs[0].transaction_type).toBe("SALARY");
    expect(txs[1].transaction_type).toBe("ATM");
  });

  it("keeps narration that contains numbers", () => {
    const txs = reconstructFromLines([
      "2024-03-01",
      "PAYMENT FOR INVOICE 12345 ORDER 98",
      "1,000.00 DR",
    ]);
    expect(txs[0].description).toContain("INVOICE 12345");
    expect(txs[0].description).toContain("ORDER 98");
  });

  it("handles negative parentheses amounts", () => {
    const txs = reconstructFromLines(["15/03/2024", "REVERSAL FEE", "(25.00)"]);
    expect(txs[0].amount).toBe(-25);
    expect(txs[0].debit).toBe(25);
  });
});

describe("structured table reconstruction", () => {
  it("reads debit/credit columns and wraps continuation description rows", () => {
    const table = tableFromRows(
      [
        { raw: "Date", field: "transaction_date" },
        { raw: "Description", field: "description" },
        { raw: "Debit", field: "debit" },
        { raw: "Credit", field: "credit" },
        { raw: "Balance", field: "balance" },
      ],
      [
        ["2024-01-04", "ONLINE TRANSFER TO", "150.00", "", "3345.50"],
        ["", "JOHN DOE REF 998877", "", "", ""],
        ["2024-01-05", "ATM WITHDRAWAL", "200.00", "", "3145.50"],
      ],
    );

    // Mark second row continuation
    table.rows[2].is_continuation = true;

    const txs = reconstructFromTable(table, "NGN");
    expect(txs.length).toBeGreaterThanOrEqual(2);
    expect(txs[0].description).toMatch(/ONLINE TRANSFER TO/i);
    expect(txs[0].description).toMatch(/JOHN DOE/i);
    expect(txs[0].reference).toBe("998877");
    expect(txs[0].debit).toBe(150);
    expect(txs[0].credit).toBeNull();
    expect(txs[0].amount).toBe(-150);
    expect(txs[0].balance).toBe(3345.5);
    expect(txs[1].transaction_type).toBe("ATM");
  });

  it("supports withdrawal/deposit headers and EU amounts", () => {
    const table = tableFromRows(
      [
        { raw: "Value Date", field: "value_date" },
        { raw: "Narration", field: "description" },
        { raw: "Withdrawal", field: "debit" },
        { raw: "Deposit", field: "credit" },
        { raw: "Running Balance", field: "balance" },
      ],
      [["12.09.2026", "TRF TO MERCHANT", "50.000,00", "", "1.200.000,00"]],
    );
    const txs = reconstructFromTable(table, "NGN");
    expect(txs).toHaveLength(1);
    expect(txs[0].transaction_date).toBe("2026-09-12");
    expect(txs[0].value_date).toBe("2026-09-12");
    expect(txs[0].debit).toBe(50000);
    expect(txs[0].balance).toBe(1_200_000);
  });

  it("leaves missing balance/reference as null", () => {
    const table = tableFromRows(
      [
        { raw: "Date", field: "transaction_date" },
        { raw: "Details", field: "description" },
        { raw: "Amount", field: "amount" },
      ],
      [["2024-06-01", "UNKNOWN MERCHANT", "-75.25"]],
    );
    const txs = reconstructFromTable(table);
    expect(txs[0].reference).toBeNull();
    expect(txs[0].balance).toBeNull();
    expect(txs[0].amount).toBe(-75.25);
    expect(txs[0].debit).toBe(75.25);
  });
});

describe("reconstructTransactions from intermediate", () => {
  it("uses tables when present", () => {
    const table = tableFromRows(
      [
        { raw: "Date", field: "transaction_date" },
        { raw: "Description", field: "description" },
        { raw: "Credit", field: "credit" },
      ],
      [["2024-01-03", "SALARY PAYMENT", "2500.00"]],
    );

    const intermediate: IntermediateExtraction = IntermediateExtractionSchema.parse({
      document_id: "stmt_test",
      source_extension: "csv",
      mime_type: "text/csv",
      extraction_method: "csv",
      pdf_kind: null,
      page_count: 1,
      sheet_names: [],
      pages: [],
      tables: [table],
      cells: [],
      warnings: [],
      extracted_at: new Date().toISOString(),
    });

    const txs = reconstructTransactions(intermediate, "NGN");
    expect(txs).toHaveLength(1);
    expect(txs[0].credit).toBe(2500);
    expect(txs[0].transaction_type).toBe("SALARY");
  });
});
