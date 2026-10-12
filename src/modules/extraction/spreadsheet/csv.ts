/**
 * CSV structured extraction with header / summary / empty-row detection.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import {
  detectHeaderRow,
  isLikelyFooterRow,
  isLikelySummaryRow,
  mapHeaderToField,
} from "../headers.js";
import {
  IntermediateExtractionSchema,
  type IntermediateCell,
  type IntermediateExtraction,
  type IntermediateRow,
  type IntermediateTable,
} from "../types.js";

function parseCsvWithDelimiter(text: string, delimiter: "," | ";" | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (ch === "\r") continue;
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function detectDelimiter(text: string): "," | ";" | "\t" {
  const sample = text.slice(0, 4000);
  const counts = {
    ",": (sample.match(/,/g) ?? []).length,
    ";": (sample.match(/;/g) ?? []).length,
    "\t": (sample.match(/\t/g) ?? []).length,
  };
  const best = (Object.entries(counts) as Array<["," | ";" | "\t", number]>).sort(
    (a, b) => b[1] - a[1],
  )[0];
  return best[1] > 0 ? best[0] : ",";
}

export async function extractFromCsv(params: {
  documentId: string;
  localPath: string;
  mimeType?: string | null;
}): Promise<IntermediateExtraction> {
  const raw = await fs.readFile(params.localPath, "utf8");
  const delimiter = detectDelimiter(raw);
  const matrix = parseCsvWithDelimiter(raw, delimiter).filter((r) =>
    r.some((c) => String(c).trim().length > 0),
  );

  const header = detectHeaderRow(matrix);
  const headers =
    header?.mapping.filter((h) => h.raw_text.trim().length > 0) ??
    (matrix[0] ?? []).map((raw_text, column) => ({
      column,
      raw_text,
      mapped_field: mapHeaderToField(raw_text),
    }));

  const startRow = header ? header.index + 1 : 1;
  const cells: IntermediateCell[] = [];
  const rows: IntermediateRow[] = [];

  for (let r = 0; r < matrix.length; r++) {
    const values = matrix[r];
    const isHeader = header != null && r === header.index;
    const isEmpty = values.every((v) => String(v).trim() === "");
    const role = isHeader
      ? "header"
      : isEmpty
        ? "empty"
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
        page: 1,
        row: r,
        column,
        raw_text: String(raw_text ?? ""),
        bbox: null,
        extraction_method: "csv",
        ocr_confidence: null,
        role,
        mapped_field: isHeader
          ? mapHeaderToField(String(raw_text ?? ""))
          : (headers.find((h) => h.column === column)?.mapped_field ?? null),
        sheet: null,
      };
      cells.push(cell);
      return cell;
    });

    rows.push({
      id: randomUUID(),
      page: 1,
      row_index: r,
      role,
      cells: rowCells,
      is_continuation: false,
      sheet: null,
    });
  }

  const table: IntermediateTable = {
    id: randomUUID(),
    page_start: 1,
    page_end: 1,
    sheet: null,
    headers,
    rows: rows.filter((r) => r.role === "data" || r.role === "header"),
    repeated_header_pages: [],
  };

  return IntermediateExtractionSchema.parse({
    document_id: params.documentId,
    source_extension: "csv",
    mime_type: params.mimeType ?? "text/csv",
    extraction_method: "csv",
    pdf_kind: null,
    page_count: 1,
    sheet_names: [],
    pages: [
      {
        page: 1,
        width: null,
        height: null,
        kind: "text",
        text_items: [],
        raw_text: raw.slice(0, 20_000),
      },
    ],
    tables: [table],
    cells,
    warnings: header
      ? []
      : [{ code: "HEADER_NOT_DETECTED", message: "Could not confidently detect CSV header row", page: 1 }],
    extracted_at: new Date().toISOString(),
  });
}
