/**
 * Image (PNG/JPG) OCR extraction into intermediate representation.
 */

import fs from "node:fs/promises";
import sharp from "sharp";
import { ocrImageBuffer } from "../ocr/index.js";
import { buildTablesFromPdfPages } from "../pdf/tableExtract.js";
import {
  IntermediateExtractionSchema,
  type IntermediateExtraction,
} from "../types.js";
import type { PdfPageText } from "../pdf/textExtract.js";
import { config } from "../../../config/env.js";

export async function extractFromImage(params: {
  documentId: string;
  localPath: string;
  extension: "png" | "jpg" | "jpeg";
  mimeType?: string | null;
}): Promise<IntermediateExtraction> {
  const bytes = await fs.readFile(params.localPath);
  const meta = await sharp(bytes).metadata();
  const pixels = (meta.width ?? 0) * (meta.height ?? 0);
  if (pixels > config.maxImagePixels) {
    const err = new Error(
      `Image has ${pixels} pixels which exceeds MAX_IMAGE_PIXELS (${config.maxImagePixels})`,
    ) as Error & { code?: string };
    err.code = "DOCUMENT_LIMIT_EXCEEDED";
    throw err;
  }

  const ocr = await ocrImageBuffer({ image: bytes, page: 1, preprocess: true });

  const page: PdfPageText = {
    page: 1,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    items: ocr.words.map((w) => ({
      text: w.text,
      page: 1,
      bbox: w.bbox,
    })),
    raw_text: ocr.raw_text,
    char_count: ocr.raw_text.replace(/\s+/g, "").length,
  };

  const built = buildTablesFromPdfPages([page]);
  for (const cell of built.cells) {
    cell.extraction_method = "ocr_image";
    const match = ocr.words.find((w) => w.text === cell.raw_text);
    if (match?.confidence != null) cell.ocr_confidence = match.confidence;
  }

  return IntermediateExtractionSchema.parse({
    document_id: params.documentId,
    source_extension: params.extension === "jpeg" ? "jpg" : params.extension,
    mime_type: params.mimeType ?? (params.extension === "png" ? "image/png" : "image/jpeg"),
    extraction_method: "ocr_image",
    pdf_kind: null,
    page_count: 1,
    sheet_names: [],
    pages: [
      {
        page: 1,
        width: meta.width ?? null,
        height: meta.height ?? null,
        kind: "image",
        text_items: ocr.words.map((w) => ({
          text: w.text,
          bbox: w.bbox,
          ocr_confidence: w.confidence,
        })),
        raw_text: ocr.raw_text,
      },
    ],
    tables: built.tables.map((t) => ({
      ...t,
      rows: t.rows.map((r) => ({
        ...r,
        cells: r.cells.map((c) => ({ ...c, extraction_method: "ocr_image" as const })),
      })),
    })),
    cells: built.cells,
    warnings:
      ocr.words.length === 0
        ? [{ code: "OCR_EMPTY", message: "OCR produced no words", page: 1 }]
        : [],
    extracted_at: new Date().toISOString(),
  });
}
