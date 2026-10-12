/**
 * Format-specific parsers registry (PDF, CSV, XLS/XLSX, image).
 */

import type { SupportedExtension } from "../../contracts/index.js";

export type ParserName = "pdf" | "csv" | "xls" | "xlsx" | "image";

export function resolveParser(extension: SupportedExtension | null): ParserName | null {
  if (!extension) return null;
  if (extension === "jpg" || extension === "jpeg" || extension === "png") return "image";
  if (extension === "pdf") return "pdf";
  if (extension === "csv") return "csv";
  if (extension === "xls") return "xls";
  if (extension === "xlsx") return "xlsx";
  return null;
}
