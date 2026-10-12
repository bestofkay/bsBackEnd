/**
 * Classify PDF pages as native text, scanned/image, or mixed.
 */

import type { PdfKind } from "../types.js";
import type { PdfPageText, PdfTextExtraction } from "./textExtract.js";

const NATIVE_CHAR_THRESHOLD = 40;
const SCANNED_CHAR_THRESHOLD = 12;

export type PageKind = "text" | "image" | "mixed";

export function classifyPdfPage(page: PdfPageText): PageKind {
  if (page.char_count >= NATIVE_CHAR_THRESHOLD) return "text";
  if (page.char_count <= SCANNED_CHAR_THRESHOLD) return "image";
  return "mixed";
}

export function classifyPdfDocument(extraction: PdfTextExtraction): {
  pdf_kind: PdfKind;
  page_kinds: PageKind[];
} {
  const page_kinds = extraction.pages.map(classifyPdfPage);
  const textPages = page_kinds.filter((k) => k === "text").length;
  const imagePages = page_kinds.filter((k) => k === "image").length;
  const mixedPages = page_kinds.filter((k) => k === "mixed").length;

  let pdf_kind: PdfKind;
  if (imagePages === page_kinds.length) pdf_kind = "scanned";
  else if (textPages === page_kinds.length && mixedPages === 0) pdf_kind = "native";
  else if (textPages > 0 && imagePages > 0) pdf_kind = "mixed";
  else if (mixedPages > 0 && imagePages > 0) pdf_kind = "mixed";
  else if (textPages > 0) pdf_kind = "native";
  else pdf_kind = "scanned";

  return { pdf_kind, page_kinds };
}
