/**
 * XLS / XLSX structured extraction via SheetJS.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import * as XLSX from "xlsx";
import {
  detectHeaderRow,
  isLikelyFooterRow,
  isLikelySummaryRow,
  mapHeaderToField,
  scoreHeaderRow,
} from "../headers.js";
import {
  IntermediateExtractionSchema,
  type IntermediateCell,
  type IntermediateExtraction,
  type IntermediateRow,
  type IntermediateTable,
} from "../types.js";

function sheetLooksLikeTransactions(matrix: string[][]): boolean {
  const header = detectHeaderRow(matrix);
  if (header) return true;
  // Weak signal: several rows with date-like + amount-like tokens
  let hits = 0;
  for (const row of matrix.slice(0, 40)) {
    const joined = row.join(" ");
    if (/\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/.test(joined) && /\d+[.,]\d{2}/.test(joined)) {
      hits += 1;
    }
  }
  return hits >= 2;
}

function matrixFromSheet(sheet: XLSX.WorkSheet): string[][] {
  const rows = XLSX.utils.sheet_to_json<(string | number | null | undefined)[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });
  return rows.map((r) => r.map((c) => String(c ?? "").trim()));
}

function buildTableFromMatrix(
  matrix: string[][],
  sheetName: string,
  method: "xlsx" | "xls",
): { table: IntermediateTable; cells: IntermediateCell[]; rows: IntermediateRow[] } {
  const header = detectHeaderRow(matrix);
  const headers =
    header?.mapping.filter((h) => h.raw_text.trim().length > 0) ??
    (matrix[0] ?? []).map((raw_text, column) => ({
      column,
      raw_text,
      mapped_field: mapHeaderToField(raw_text),
    }));

  const cells: IntermediateCell[] = [];
  const rows: IntermediateRow[] = [];
  const startRow = header ? header.index + 1 : 0;

  for (let r = 0; r < matrix.length; r++) {
    const values = matrix[r];
    if (values.every((v) => v === "")) continue;

    const isHeader = header != null && r === header.index;
    const role = isHeader
      ? "header"
      : isLikelySummaryRow(values)
        ? "summary"
        : isLikelyFooterRow(values)
          ? "footer"
          : r < startRow
            ? "unknown"
            : "data";

    const rowCells: IntermediateCell[] = values.map((raw_text, column) => {
      const cell: IntermediateCell = {
        id: randomUUID(),
        page: null,
        row: r,
        column,
        raw_text,
        bbox: null,
        extraction_method: method,
        ocr_confidence: null,
        role,
        mapped_field: isHeader
          ? mapHeaderToField(raw_text)
          : (headers.find((h) => h.column === column)?.mapped_field ?? null),
        sheet: sheetName,
      };
      cells.push(cell);
      return cell;
    });

    rows.push({
      id: randomUUID(),
      page: null,
      row_index: r,
      role,
      cells: rowCells,
      is_continuation: false,
      sheet: sheetName,
    });
  }

  const table: IntermediateTable = {
    id: randomUUID(),
    page_start: null,
    page_end: null,
    sheet: sheetName,
    headers,
    rows: rows.filter((r) => r.role === "data" || r.role === "header"),
    repeated_header_pages: [],
  };

  return { table, cells, rows };
}

export async function extractFromSpreadsheet(params: {
  documentId: string;
  localPath: string;
  extension: "xls" | "xlsx";
  mimeType?: string | null;
}): Promise<IntermediateExtraction> {
  const buffer = await fs.readFile(params.localPath);
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const method = params.extension;
  const sheetNames = workbook.SheetNames;
  const tables: IntermediateTable[] = [];
  const cells: IntermediateCell[] = [];
  const warnings: IntermediateExtraction["warnings"] = [];

  for (const name of sheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const matrix = matrixFromSheet(sheet);
    if (matrix.length === 0) continue;

    const interesting = sheetLooksLikeTransactions(matrix);
    if (!interesting && sheetNames.length > 1) {
      // Skip irrelevant sheets when multiple exist.
      const top = matrix.slice(0, 5).map((r) => scoreHeaderRow(r));
      if (Math.max(0, ...top) < 3) {
        warnings.push({
          code: "SHEET_SKIPPED",
          message: `Skipped sheet '${name}' — no transaction-like structure detected`,
          page: null,
        });
        continue;
      }
    }

    const built = buildTableFromMatrix(matrix, name, method);
    tables.push(built.table);
    cells.push(...built.cells);
  }

  if (tables.length === 0 && sheetNames.length > 0) {
    // Fallback: take first sheet even if weak.
    const name = sheetNames[0];
    const built = buildTableFromMatrix(matrixFromSheet(workbook.Sheets[name]!), name, method);
    tables.push(built.table);
    cells.push(...built.cells);
    warnings.push({
      code: "WEAK_SHEET_FALLBACK",
      message: `No strong transaction sheet found; using '${name}'`,
      page: null,
    });
  }

  return IntermediateExtractionSchema.parse({
    document_id: params.documentId,
    source_extension: params.extension,
    mime_type: params.mimeType ?? null,
    extraction_method: method,
    pdf_kind: null,
    page_count: 0,
    sheet_names: sheetNames,
    pages: [],
    tables,
    cells,
    warnings,
    extracted_at: new Date().toISOString(),
  });
}
