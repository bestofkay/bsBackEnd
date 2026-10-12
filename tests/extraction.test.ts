/**
 * Group 3 document extraction tests + fixtures.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractIntermediate } from "../src/modules/extraction/index.js";
import { mapHeaderToField, detectHeaderRow, scoreHeaderRow } from "../src/modules/extraction/headers.js";
import { classifyPdfDocument } from "../src/modules/extraction/pdf/detect.js";
import { extractPdfText } from "../src/modules/extraction/pdf/textExtract.js";
import { writeFixtures } from "./fixtures/generate.js";
import { terminateOcrWorker } from "../src/modules/extraction/ocr/index.js";

describe("header detection", () => {
  it("maps common header aliases", () => {
    expect(mapHeaderToField("Transaction Date")).toBe("transaction_date");
    expect(mapHeaderToField("Value Date")).toBe("value_date");
    expect(mapHeaderToField("Posting Date")).toBe("posting_date");
    expect(mapHeaderToField("Narration")).toBe("description");
    expect(mapHeaderToField("Details")).toBe("description");
    expect(mapHeaderToField("Withdrawal")).toBe("debit");
    expect(mapHeaderToField("Deposit")).toBe("credit");
    expect(mapHeaderToField("Running Balance")).toBe("balance");
    expect(mapHeaderToField("Reference")).toBe("reference");
  });

  it("detects header rows among preamble lines", () => {
    const rows = [
      ["Demo Bank"],
      ["Account 123"],
      ["Date", "Description", "Debit", "Credit", "Balance"],
      ["2024-01-02", "Coffee", "4.50", "", "995.50"],
    ];
    const detected = detectHeaderRow(rows);
    expect(detected).not.toBeNull();
    expect(detected!.index).toBe(2);
    expect(scoreHeaderRow(rows[2])).toBeGreaterThanOrEqual(4);
  });
});

describe("document extraction engine", () => {
  let fixtures: Awaited<ReturnType<typeof writeFixtures>>;
  let tmpDir: string;

  beforeAll(async () => {
    fixtures = await writeFixtures();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bs-extract-"));
  }, 120_000);

  afterAll(async () => {
    await terminateOcrWorker();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function copyFixture(src: string, name: string): Promise<string> {
    const dest = path.join(tmpDir, name);
    await fs.copyFile(src, dest);
    return dest;
  }

  it("extracts CSV into intermediate tables with mapped headers", async () => {
    const localPath = await copyFixture(fixtures.csv, "statement.csv");
    const result = await extractIntermediate({
      runId: "run_csv",
      document: {
        document_id: "stmt_csv",
        source_type: "upload",
        local_path: localPath,
        extension: "csv",
        mime_type: "text/csv",
        original_filename: "statement.csv",
        file_size: 100,
        size_bytes: 100,
        metadata: {},
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intermediate.extraction_method).toBe("csv");
    expect(result.intermediate.tables.length).toBeGreaterThan(0);
    const headers = result.intermediate.tables[0].headers.map((h) => h.mapped_field);
    expect(headers).toContain("transaction_date");
    expect(headers).toContain("description");
    const dataRows = result.intermediate.tables[0].rows.filter((r) => r.role === "data");
    expect(dataRows.length).toBeGreaterThanOrEqual(3);
  });

  it("extracts XLSX and ignores irrelevant sheets", async () => {
    const localPath = await copyFixture(fixtures.xlsx, "statement.xlsx");
    const result = await extractIntermediate({
      runId: "run_xlsx",
      document: {
        document_id: "stmt_xlsx",
        source_type: "upload",
        local_path: localPath,
        extension: "xlsx",
        mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        original_filename: "statement.xlsx",
        file_size: 100,
        size_bytes: 100,
        metadata: {},
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intermediate.extraction_method).toBe("xlsx");
    expect(result.intermediate.sheet_names).toContain("Transactions");
    expect(result.intermediate.tables.some((t) => t.sheet === "Transactions")).toBe(true);
    // Notes sheet should typically be skipped
    const noteTable = result.intermediate.tables.find((t) => t.sheet === "Notes");
    expect(noteTable).toBeUndefined();
  });

  it("extracts simple native PDF text + layout cells", async () => {
    const localPath = await copyFixture(fixtures.simplePdf, "simple.pdf");
    const text = await extractPdfText(localPath);
    expect(text.page_count).toBe(1);
    expect(text.pages[0].char_count).toBeGreaterThan(20);
    const kind = classifyPdfDocument(text);
    expect(kind.pdf_kind).toBe("native");

    const result = await extractIntermediate({
      runId: "run_pdf",
      document: {
        document_id: "stmt_pdf",
        source_type: "upload",
        local_path: localPath,
        extension: "pdf",
        mime_type: "application/pdf",
        original_filename: "simple.pdf",
        file_size: 100,
        size_bytes: 100,
        metadata: {},
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intermediate.pdf_kind).toBe("native");
    expect(result.intermediate.extraction_method).toBe("pdf_text");
    expect(result.intermediate.pages[0].text_items.length).toBeGreaterThan(0);
    expect(result.intermediate.cells.length).toBeGreaterThan(0);
  });

  it("extracts multi-page PDF with page metadata", async () => {
    const localPath = await copyFixture(fixtures.multiPdf, "multi.pdf");
    const result = await extractIntermediate({
      runId: "run_multi",
      document: {
        document_id: "stmt_multi",
        source_type: "upload",
        local_path: localPath,
        extension: "pdf",
        mime_type: "application/pdf",
        original_filename: "multi.pdf",
        file_size: 100,
        size_bytes: 100,
        metadata: {},
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intermediate.page_count).toBe(2);
    expect(result.intermediate.pages).toHaveLength(2);
  });

  it("handles wrapped description PDF without crashing", async () => {
    const localPath = await copyFixture(fixtures.wrappedPdf, "wrapped.pdf");
    const result = await extractIntermediate({
      runId: "run_wrap",
      document: {
        document_id: "stmt_wrap",
        source_type: "upload",
        local_path: localPath,
        extension: "pdf",
        mime_type: "application/pdf",
        original_filename: "wrapped.pdf",
        file_size: 100,
        size_bytes: 100,
        metadata: {},
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intermediate.tables.length).toBeGreaterThan(0);
  });

  it("classifies near-empty PDF as scanned", async () => {
    const localPath = await copyFixture(fixtures.scannedPdf, "scanned.pdf");
    const text = await extractPdfText(localPath);
    const kind = classifyPdfDocument(text);
    expect(kind.pdf_kind).toBe("scanned");

    const result = await extractIntermediate({
      runId: "run_scan",
      document: {
        document_id: "stmt_scan",
        source_type: "upload",
        local_path: localPath,
        extension: "pdf",
        mime_type: "application/pdf",
        original_filename: "scanned.pdf",
        file_size: 100,
        size_bytes: 100,
        metadata: {},
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intermediate.pdf_kind).toBe("scanned");
    expect(["pdf_ocr", "pdf_mixed"]).toContain(result.intermediate.extraction_method);
  });

  it(
    "OCR extracts text+bbox+confidence from synthetic PNG statement",
    async () => {
      const localPath = await copyFixture(fixtures.png, "statement.png");
      const result = await extractIntermediate({
        runId: "run_png",
        document: {
          document_id: "stmt_png",
          source_type: "upload",
          local_path: localPath,
          extension: "png",
          mime_type: "image/png",
          original_filename: "statement.png",
          file_size: 100,
          size_bytes: 100,
          metadata: {},
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.intermediate.extraction_method).toBe("ocr_image");
      expect(result.intermediate.pages[0].text_items.length).toBeGreaterThan(0);
      const withBox = result.intermediate.pages[0].text_items.filter((t) => t.bbox != null);
      expect(withBox.length).toBeGreaterThan(0);
      // At least some OCR confidences should be present
      const withConf = result.intermediate.pages[0].text_items.filter(
        (t) => t.ocr_confidence != null,
      );
      expect(withConf.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
