/**
 * Document module — identifies document kind and metadata after ingestion.
 * OCR / PDF parsing are intentionally not implemented in Group 1.
 */

import type { DocumentInput, SupportedExtension, SupportedMimeType } from "../../contracts/index.js";

const EXTENSION_TO_MIME: Record<SupportedExtension, SupportedMimeType> = {
  pdf: "application/pdf",
  csv: "text/csv",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

export function extensionFromFilename(filename: string | null | undefined): SupportedExtension | null {
  if (!filename) return null;
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  if (!match) return null;
  const ext = match[1].toLowerCase();
  if (ext === "jpg" || ext === "jpeg" || ext === "png" || ext === "pdf" || ext === "csv" || ext === "xls" || ext === "xlsx") {
    return ext;
  }
  return null;
}

export function mimeFromExtension(ext: SupportedExtension | null): SupportedMimeType | null {
  if (!ext) return null;
  return EXTENSION_TO_MIME[ext];
}

export function identifyDocument(input: DocumentInput): DocumentInput {
  const nameHint =
    input.original_filename ?? input.filename ?? input.source_url ?? input.url ?? null;
  const extension = input.extension ?? extensionFromFilename(nameHint);
  const mime_type = input.mime_type ?? mimeFromExtension(extension);

  return {
    ...input,
    extension,
    mime_type,
  };
}
