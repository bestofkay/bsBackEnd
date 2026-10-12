/**
 * Reconstruct table rows/columns from positioned PDF text items.
 * Handles wrapped description lines and repeated headers across pages.
 */

import { randomUUID } from "node:crypto";
import {
  detectHeaderRow,
  isLikelyFooterRow,
  isLikelySummaryRow,
  mapHeaderToField,
  scoreHeaderRow,
} from "../headers.js";
import type {
  BoundingBox,
  IntermediateCell,
  IntermediateRow,
  IntermediateTable,
} from "../types.js";
import type { PdfTextItem, PdfPageText } from "./textExtract.js";

const Y_LINE_TOLERANCE = 4;

type Line = {
  page: number;
  y: number;
  items: PdfTextItem[];
  text: string;
};

function lineKey(y: number): number {
  return Math.round(y / Y_LINE_TOLERANCE) * Y_LINE_TOLERANCE;
}

export function clusterItemsIntoLines(items: PdfTextItem[]): Line[] {
  const buckets = new Map<number, PdfTextItem[]>();
  for (const item of items) {
    const key = lineKey(item.bbox.y0);
    const list = buckets.get(key) ?? [];
    list.push(item);
    buckets.set(key, list);
  }

  const lines: Line[] = [];
  for (const [y, bucket] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = bucket.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    lines.push({
      page: sorted[0]?.page ?? 1,
      y,
      items: sorted,
      text: sorted.map((i) => i.text).join(" "),
    });
  }
  return lines;
}

function inferColumnBounds(headerLine: Line, dataLines: Line[]): number[] {
  // Use gaps in header item positions; fall back to equal-ish clusters from data.
  const xs = headerLine.items.map((i) => i.bbox.x0).sort((a, b) => a - b);
  if (xs.length >= 2) return xs;

  const allX: number[] = [];
  for (const line of dataLines.slice(0, 40)) {
    for (const item of line.items) allX.push(item.bbox.x0);
  }
  allX.sort((a, b) => a - b);
  if (allX.length === 0) return [0];

  const cols: number[] = [allX[0]];
  for (const x of allX) {
    if (x - cols[cols.length - 1] > 40) cols.push(x);
  }
  return cols;
}

function assignToColumns(line: Line, columnXs: number[]): string[] {
  const cells = columnXs.map(() => "");
  for (const item of line.items) {
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let c = 0; c < columnXs.length; c++) {
      const dist = Math.abs(item.bbox.x0 - columnXs[c]);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    cells[best] = cells[best] ? `${cells[best]} ${item.text}` : item.text;
  }
  return cells.map((c) => c.trim());
}

function unionBBox(items: PdfTextItem[]): BoundingBox | null {
  if (items.length === 0) return null;
  return {
    x0: Math.min(...items.map((i) => i.bbox.x0)),
    y0: Math.min(...items.map((i) => i.bbox.y0)),
    x1: Math.max(...items.map((i) => i.bbox.x1)),
    y1: Math.max(...items.map((i) => i.bbox.y1)),
  };
}

function looksLikeDate(value: string): boolean {
  return /^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(value.trim()) ||
    /^\d{1,2}\s+[A-Za-z]{3,}\s+\d{2,4}$/.test(value.trim());
}

/**
 * Merge continuation lines (wrapped descriptions) into previous data rows.
 */
export function mergeWrappedRows(
  rows: Array<{ cells: string[]; page: number; line: Line }>,
  dateCol: number | null,
): Array<{ cells: string[]; page: number; line: Line; is_continuation: boolean }> {
  const out: Array<{ cells: string[]; page: number; line: Line; is_continuation: boolean }> = [];
  for (const row of rows) {
    const dateVal = dateCol != null ? row.cells[dateCol] ?? "" : row.cells[0] ?? "";
    const hasDate = looksLikeDate(dateVal);
    const prev = out[out.length - 1];
    if (!hasDate && prev && prev.cells.some((c) => c.trim())) {
      // Continuation — append into description-ish emptiest non-date columns / largest text cell.
      let target = 1;
      let longest = -1;
      for (let i = 0; i < prev.cells.length; i++) {
        if (dateCol != null && i === dateCol) continue;
        if (prev.cells[i].length > longest) {
          longest = prev.cells[i].length;
          target = i;
        }
      }
      const addon = row.cells.filter(Boolean).join(" ");
      prev.cells[target] = `${prev.cells[target]} ${addon}`.trim();
      out.push({ ...row, is_continuation: true });
      continue;
    }
    out.push({ ...row, is_continuation: false });
  }
  return out;
}

export function buildTablesFromPdfPages(pages: PdfPageText[]): {
  tables: IntermediateTable[];
  cells: IntermediateCell[];
  repeated_header_pages: number[];
} {
  const allLines = pages.flatMap((p) => clusterItemsIntoLines(p.items));
  if (allLines.length === 0) {
    return { tables: [], cells: [], repeated_header_pages: [] };
  }

  // Probe header among early lines.
  const probeRows = allLines.slice(0, 40).map((l) => l.items.map((i) => i.text));
  // Also try joined line text split on 2+ spaces.
  const spacedRows = allLines.slice(0, 40).map((l) =>
    l.text.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean),
  );

  let headerDetect = detectHeaderRow(probeRows);
  let usingSpaced = false;
  const spaced = detectHeaderRow(spacedRows);
  if (!headerDetect || (spaced && scoreHeaderRow(spacedRows[spaced.index] ?? []) > scoreHeaderRow(probeRows[headerDetect.index] ?? []))) {
    if (spaced) {
      headerDetect = spaced;
      usingSpaced = true;
    }
  }

  const headerLine = headerDetect ? allLines[headerDetect.index] : allLines[0];
  const columnXs = inferColumnBounds(headerLine, allLines.slice((headerDetect?.index ?? 0) + 1));

  const matrix = allLines.map((line) =>
    usingSpaced
      ? line.text.split(/\s{2,}/).map((s) => s.trim())
      : assignToColumns(line, columnXs),
  );

  // Re-detect on constructed matrix for stable mapping
  const header = detectHeaderRow(matrix) ?? headerDetect;
  const headers =
    header?.mapping.map((h) => ({
      column: h.column,
      raw_text: h.raw_text,
      mapped_field: h.mapped_field === "unknown" ? mapHeaderToField(h.raw_text) : h.mapped_field,
    })) ??
    (matrix[0] ?? []).map((raw_text, column) => ({
      column,
      raw_text,
      mapped_field: mapHeaderToField(raw_text),
    }));

  const dateCol =
    headers.find((h) =>
      ["transaction_date", "value_date", "posting_date"].includes(h.mapped_field),
    )?.column ?? null;

  const headerText = headers.map((h) => h.raw_text.toLowerCase()).join("|");
  const repeated_header_pages: number[] = [];

  const dataCandidates: Array<{ cells: string[]; page: number; line: Line }> = [];
  for (let i = 0; i < allLines.length; i++) {
    if (header && i === header.index) continue;
    const cells = matrix[i] ?? [];
    // Skip repeated headers
    if (
      header &&
      scoreHeaderRow(cells) >= 4 &&
      cells.map((c) => c.toLowerCase()).join("|") === headerText
    ) {
      repeated_header_pages.push(allLines[i].page);
      continue;
    }
    if (isLikelyFooterRow(cells)) continue;
    dataCandidates.push({ cells, page: allLines[i].page, line: allLines[i] });
  }

  const merged = mergeWrappedRows(dataCandidates, dateCol);
  const cells: IntermediateCell[] = [];
  const rows: IntermediateRow[] = [];

  // Header row
  if (header) {
    const headerCells = (matrix[header.index] ?? []).map((raw_text, column) => {
      const cell: IntermediateCell = {
        id: randomUUID(),
        page: allLines[header.index]?.page ?? 1,
        row: header.index,
        column,
        raw_text,
        bbox: unionBBox(allLines[header.index]?.items ?? []),
        extraction_method: "pdf_text",
        ocr_confidence: null,
        role: "header",
        mapped_field: mapHeaderToField(raw_text),
        sheet: null,
      };
      cells.push(cell);
      return cell;
    });
    rows.push({
      id: randomUUID(),
      page: allLines[header.index]?.page ?? 1,
      row_index: header.index,
      role: "header",
      cells: headerCells,
      is_continuation: false,
      sheet: null,
    });
  }

  let rowIndex = (header?.index ?? -1) + 1;
  for (const entry of merged) {
    if (entry.is_continuation) continue; // content already merged into previous cells text
    const role = isLikelySummaryRow(entry.cells)
      ? "summary"
      : entry.cells.every((c) => !c) ? "empty" : "data";
    if (role === "empty") continue;

    const rowCells = entry.cells.map((raw_text, column) => {
      const cell: IntermediateCell = {
        id: randomUUID(),
        page: entry.page,
        row: rowIndex,
        column,
        raw_text,
        bbox: unionBBox(entry.line.items),
        extraction_method: "pdf_text",
        ocr_confidence: null,
        role,
        mapped_field: headers.find((h) => h.column === column)?.mapped_field ?? null,
        sheet: null,
      };
      cells.push(cell);
      return cell;
    });

    rows.push({
      id: randomUUID(),
      page: entry.page,
      row_index: rowIndex,
      role,
      cells: rowCells,
      is_continuation: false,
      sheet: null,
    });
    rowIndex += 1;
  }

  // Apply wrapped description merges onto last data row texts already done in mergeWrappedRows
  // Re-apply merged cell text onto row cells
  let dataIdx = 0;
  for (const entry of merged) {
    if (entry.is_continuation) continue;
    const row = rows.find((r) => r.role === "data" || r.role === "summary");
    void row;
    const target = rows.filter((r) => r.role === "data" || r.role === "summary")[dataIdx];
    if (target) {
      for (let c = 0; c < entry.cells.length; c++) {
        if (target.cells[c]) target.cells[c].raw_text = entry.cells[c];
      }
    }
    dataIdx += 1;
  }

  const table: IntermediateTable = {
    id: randomUUID(),
    page_start: pages[0]?.page ?? 1,
    page_end: pages[pages.length - 1]?.page ?? 1,
    sheet: null,
    headers,
    rows,
    repeated_header_pages: [...new Set(repeated_header_pages)],
  };

  return { tables: [table], cells, repeated_header_pages: table.repeated_header_pages };
}
