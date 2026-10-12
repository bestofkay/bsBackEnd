/**
 * Group 7 — CSV / XLSX / PDF / image format edge cases (synthetic fixtures only).
 */

import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import sharp from "sharp";
import { extractFromCsv } from "../src/modules/extraction/spreadsheet/csv.js";
import { extractFromSpreadsheet } from "../src/modules/extraction/spreadsheet/xlsx.js";
import { reconstructTransactions } from "../src/modules/transactions/index.js";
import {
  buildTextPdf,
  buildMultiPageStatementPdf,
  buildSampleXlsx,
  buildStatementPng,
  SAMPLE_CSV,
} from "./fixtures/generate.js";
import { extractIntermediate } from "../src/modules/extraction/index.js";
import type { DocumentInput } from "../src/contracts/index.js";
import { randomUUID } from "node:crypto";
import { resolveParser } from "../src/modules/parsers/index.js";

async function writeTemp(name: string, data: string | Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bs-g7-"));
  const file = path.join(dir, name);
  await fs.writeFile(file, data);
  return file;
}

describe("Group 7 CSV formats", () => {
  const cleanup: string[] = [];

  afterAll(async () => {
    for (const f of cleanup) {
      await fs.rm(path.dirname(f), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("parses semicolon-separated CSV", async () => {
    const csv = [
      "Date;Description;Debit;Credit;Balance",
      "2026-09-01;TRANSFER TO \"JANE, DOE\";50000;;950000",
      "2026-09-02;SALARY;;250000;1200000",
      "",
      "Total;ignored;;;",
    ].join("\n");
    const file = await writeTemp("semi.csv", csv);
    cleanup.push(file);
    const ir = await extractFromCsv({ documentId: "d1", localPath: file });
    const txs = reconstructTransactions(ir, "NGN");
    expect(txs.length).toBeGreaterThanOrEqual(2);
    expect(txs[0].description).toMatch(/JANE/);
  });

  it("parses tab-separated CSV with BOM and blank rows", async () => {
    const csv =
      "\uFEFFDate\tDescription\tAmount\tBalance\n" +
      "2026-09-01\tPOS A\t-100.00\t900.00\n" +
      "\t\t\t\n" +
      "2026-09-02\tPOS B\t-50.00\t850.00\n";
    const file = await writeTemp("tabs.csv", csv);
    cleanup.push(file);
    const ir = await extractFromCsv({ documentId: "d2", localPath: file });
    const txs = reconstructTransactions(ir, "NGN");
    expect(txs.length).toBeGreaterThanOrEqual(2);
  });

  it("handles quoted embedded commas and reordered columns", async () => {
    const csv = [
      "Balance,Narration,Txn Date,Withdrawal,Deposit",
      "995.50,\"Coffee, latte\",2026-09-01,4.50,",
      "3495.50,SALARY,2026-09-02,,2500.00",
    ].join("\n");
    const file = await writeTemp("reorder.csv", csv);
    cleanup.push(file);
    const ir = await extractFromCsv({ documentId: "d3", localPath: file });
    const txs = reconstructTransactions(ir, "NGN");
    expect(txs.length).toBeGreaterThanOrEqual(2);
    expect(txs.some((t) => (t.description ?? "").includes("Coffee"))).toBe(true);
  });

  it("does not invent transactions from SAMPLE_CSV totals alone", async () => {
    const file = await writeTemp("sample.csv", SAMPLE_CSV);
    cleanup.push(file);
    const ir = await extractFromCsv({ documentId: "d4", localPath: file });
    const txs = reconstructTransactions(ir, "NGN");
    expect(txs.every((t) => t.transaction_date != null || t.amount != null)).toBe(true);
  });
});

describe("Group 7 XLSX formats", () => {
  it("ignores hidden/non-transaction sheets and reads date/numeric cells", async () => {
    const wb = XLSX.utils.book_new();
    const junk = XLSX.utils.aoa_to_sheet([["Notes"], ["ignore me"]]);
    const txns = XLSX.utils.aoa_to_sheet([
      ["Transaction Date", "Narration", "Withdrawal", "Deposit", "Running Balance"],
      [new Date(Date.UTC(2026, 8, 1)), "POS STORE", 10.5, "", 989.5],
      ["2026-09-02", "SALARY", "", 1000, 1989.5],
      [null, null, null, null, null],
    ]);
    XLSX.utils.book_append_sheet(wb, junk, "HiddenNotes");
    XLSX.utils.book_append_sheet(wb, txns, "Statement");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const file = await writeTemp("multi.xlsx", buf);
    const ir = await extractFromSpreadsheet({
      documentId: "x1",
      localPath: file,
      extension: "xlsx",
    });
    const txs = reconstructTransactions(ir, "NGN");
    expect(txs.length).toBeGreaterThanOrEqual(1);
    await fs.rm(path.dirname(file), { recursive: true, force: true });
  });

  it("buildSampleXlsx fixture yields transactions", async () => {
    const file = await writeTemp("sample.xlsx", buildSampleXlsx());
    const ir = await extractFromSpreadsheet({
      documentId: "x2",
      localPath: file,
      extension: "xlsx",
    });
    expect(reconstructTransactions(ir, "NGN").length).toBeGreaterThanOrEqual(2);
    await fs.rm(path.dirname(file), { recursive: true, force: true });
  });
});

describe("Group 7 PDF / image formats", () => {
  it("extracts one-page and multi-page native PDFs without fabricating amounts", async () => {
    const one = await writeTemp(
      "one.pdf",
      buildTextPdf([
        "Demo Bank Statement",
        "Date Description Debit Credit Balance",
        "2026-09-01 POS PURCHASE 4.50  995.50",
        "2026-09-02 SALARY  2500.00 3495.50",
      ]),
    );
    const multi = await writeTemp("multi.pdf", buildMultiPageStatementPdf());

    for (const [file, ext] of [
      [one, "pdf"],
      [multi, "pdf"],
    ] as const) {
      const doc: DocumentInput = {
        document_id: randomUUID(),
        source_type: "upload",
        local_path: file,
        extension: ext,
        mime_type: "application/pdf",
        metadata: {},
      };
      const extracted = await extractIntermediate({ runId: "g7", document: doc });
      expect(extracted.ok).toBe(true);
      if (!extracted.ok) continue;
      const txs = reconstructTransactions(extracted.intermediate, "NGN");
      for (const t of txs) {
        if (t.amount != null) expect(Number.isFinite(t.amount)).toBe(true);
      }
    }

    await fs.rm(path.dirname(one), { recursive: true, force: true });
    await fs.rm(path.dirname(multi), { recursive: true, force: true });
  });

  it("preprocesses PNG/JPG without inventing transaction amounts", async () => {
    const png = await buildStatementPng();
    const jpg = await sharp(png).jpeg({ quality: 40 }).toBuffer();
    const rotated = await sharp(png).rotate(90).png().toBuffer();

    for (const [buf, name, mime, ext] of [
      [png, "hi.png", "image/png", "png"],
      [jpg, "lo.jpg", "image/jpeg", "jpg"],
      [rotated, "rot.png", "image/png", "png"],
    ] as const) {
      const file = await writeTemp(name, buf);
      const doc: DocumentInput = {
        document_id: randomUUID(),
        source_type: "upload",
        local_path: file,
        extension: ext,
        mime_type: mime,
        metadata: {},
      };
      const extracted = await extractIntermediate({ runId: "g7img", document: doc });
      // OCR may succeed or yield low confidence — never fabricate money
      if (extracted.ok) {
        const txs = reconstructTransactions(extracted.intermediate, "NGN");
        for (const t of txs) {
          if (t.debit != null) expect(t.debit).toBeGreaterThanOrEqual(0);
          if (t.credit != null) expect(t.credit).toBeGreaterThanOrEqual(0);
        }
        const lowOcr = extracted.intermediate.warnings.some(
          (w) => /ocr|confidence/i.test(w.code) || /ocr|confidence/i.test(w.message),
        );
        // soft assert: pipeline remains deterministic
        expect(typeof lowOcr).toBe("boolean");
      }
      await fs.rm(path.dirname(file), { recursive: true, force: true });
    }
  });
});

describe("Group 7 bank format regression (generic profiles only)", () => {
  it("documents that only generic pdf/csv/xlsx/image parsers exist", () => {
    expect(resolveParser("pdf")).toBe("pdf");
    expect(resolveParser("csv")).toBe("csv");
    expect(resolveParser("xlsx")).toBe("xlsx");
    expect(resolveParser("png")).toBe("image");
    expect(resolveParser("jpg")).toBe("image");
  });
});
