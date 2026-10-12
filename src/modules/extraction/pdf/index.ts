/**
 * PDF extraction orchestrator: detect kind, extract text/tables, OCR scanned pages.
 */

import { ocrImageBuffer } from "../ocr/index.js";
import {
  IntermediateExtractionSchema,
  type IntermediateCell,
  type IntermediateExtraction,
  type IntermediatePage,
  type IntermediateTable,
} from "../types.js";
import { classifyPdfDocument } from "./detect.js";
import { buildTablesFromPdfPages } from "./tableExtract.js";
import { extractPdfText, type PdfPageText } from "./textExtract.js";
import { renderPdfPagesToPng } from "./render.js";

async function ocrPagesToPdfText(
  localPath: string,
  pageNumbers: number[],
): Promise<{ pages: PdfPageText[]; warnings: IntermediateExtraction["warnings"] }> {
  const warnings: IntermediateExtraction["warnings"] = [];
  const rendered = await renderPdfPagesToPng(localPath, pageNumbers);
  if (rendered.length === 0) {
    warnings.push({
      code: "PDF_RENDER_UNAVAILABLE",
      message:
        "Scanned PDF pages could not be rendered for OCR. Install @napi-rs/canvas to enable rendering.",
      page: null,
    });
    return { pages: [], warnings };
  }

  const pages: PdfPageText[] = [];
  for (const img of rendered) {
    const ocr = await ocrImageBuffer({ image: img.png, page: img.page, preprocess: true });
    const items = ocr.words.map((w) => ({
      text: w.text,
      page: img.page,
      bbox: w.bbox,
    }));
    pages.push({
      page: img.page,
      width: img.width,
      height: img.height,
      items,
      raw_text: ocr.raw_text,
      char_count: ocr.raw_text.replace(/\s+/g, "").length,
    });
  }
  return { pages, warnings };
}

function buildTablesFromOcrWords(
  pages: PdfPageText[],
  method: "pdf_ocr" | "pdf_mixed",
): { tables: IntermediateTable[]; cells: IntermediateCell[] } {
  // Reuse geometric table builder, then stamp extraction_method.
  const built = buildTablesFromPdfPages(pages);
  for (const cell of built.cells) {
    cell.extraction_method = method;
  }
  for (const table of built.tables) {
    for (const row of table.rows) {
      for (const cell of row.cells) {
        cell.extraction_method = method;
      }
    }
  }
  return { tables: built.tables, cells: built.cells };
}

export async function extractFromPdf(params: {
  documentId: string;
  localPath: string;
  mimeType?: string | null;
}): Promise<IntermediateExtraction> {
  const textExtraction = await extractPdfText(params.localPath);
  const { pdf_kind, page_kinds } = classifyPdfDocument(textExtraction);
  const warnings: IntermediateExtraction["warnings"] = [];

  let method: IntermediateExtraction["extraction_method"] = "pdf_text";
  let workingPages = textExtraction.pages;
  const intermediatePages: IntermediatePage[] = textExtraction.pages.map((p, idx) => ({
    page: p.page,
    width: p.width,
    height: p.height,
    kind: page_kinds[idx] ?? "text",
    text_items: p.items.map((i) => ({
      text: i.text,
      bbox: i.bbox,
      ocr_confidence: null,
    })),
    raw_text: p.raw_text,
  }));

  if (pdf_kind === "scanned" || pdf_kind === "mixed") {
    method = pdf_kind === "scanned" ? "pdf_ocr" : "pdf_mixed";
    const ocrPageNums = textExtraction.pages
      .filter((_, idx) => page_kinds[idx] === "image" || page_kinds[idx] === "mixed" || pdf_kind === "scanned")
      .map((p) => p.page);

    try {
      const { pages: ocrPages, warnings: ocrWarnings } = await ocrPagesToPdfText(
        params.localPath,
        ocrPageNums.length > 0 ? ocrPageNums : textExtraction.pages.map((p) => p.page),
      );
      warnings.push(...ocrWarnings);

      if (ocrPages.length > 0) {
        if (pdf_kind === "scanned") {
          workingPages = ocrPages;
        } else {
          const byPage = new Map(workingPages.map((p) => [p.page, p]));
          for (const op of ocrPages) byPage.set(op.page, op);
          workingPages = [...byPage.values()].sort((a, b) => a.page - b.page);
        }

        for (const op of ocrPages) {
          const idx = intermediatePages.findIndex((p) => p.page === op.page);
          const pageView: IntermediatePage = {
            page: op.page,
            width: op.width,
            height: op.height,
            kind: "image",
            text_items: op.items.map((i) => ({
              text: i.text,
              bbox: i.bbox,
              ocr_confidence: null,
            })),
            raw_text: op.raw_text,
          };
          if (idx >= 0) intermediatePages[idx] = pageView;
          else intermediatePages.push(pageView);
        }
      }
    } catch (err) {
      warnings.push({
        code: "PDF_OCR_FAILED",
        message: err instanceof Error ? err.message : "OCR failed for scanned PDF pages",
        page: null,
      });
    }
  }

  const tableBuild =
    method === "pdf_text"
      ? buildTablesFromPdfPages(workingPages)
      : buildTablesFromOcrWords(workingPages, method === "pdf_ocr" ? "pdf_ocr" : "pdf_mixed");

  if (tableBuild.tables.length === 0) {
    warnings.push({
      code: "NO_TABLE_DETECTED",
      message: "No tabular structure detected in PDF",
      page: null,
    });
  }

  return IntermediateExtractionSchema.parse({
    document_id: params.documentId,
    source_extension: "pdf",
    mime_type: params.mimeType ?? "application/pdf",
    extraction_method: method,
    pdf_kind,
    page_count: textExtraction.page_count,
    sheet_names: [],
    pages: intermediatePages.sort((a, b) => a.page - b.page),
    tables: tableBuild.tables,
    cells: tableBuild.cells,
    warnings,
    extracted_at: new Date().toISOString(),
  });
}
