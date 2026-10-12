/**
 * Magic-byte / content sniffing for supported statement formats.
 * Never trust client Content-Type, URL extension, or filename alone.
 */

import type { SupportedExtension, SupportedMimeType } from "../../contracts/index.js";

export type DetectedFileType = {
  extension: SupportedExtension;
  mime_type: SupportedMimeType;
  confidence: "high" | "medium";
};

const ZIP_LOCAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_CFB_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);
const PDF_HEADER = Buffer.from("%PDF");

function startsWith(buf: Buffer, signature: Buffer, offset = 0): boolean {
  if (buf.length < offset + signature.length) return false;
  return buf.subarray(offset, offset + signature.length).equals(signature);
}

function bufferIncludesAscii(buf: Buffer, needle: string, limit = 8192): boolean {
  const slice = buf.subarray(0, Math.min(buf.length, limit)).toString("latin1");
  return slice.includes(needle);
}

function looksLikeHtml(buf: Buffer): boolean {
  const head = buf.subarray(0, Math.min(buf.length, 1024)).toString("utf8").trimStart().toLowerCase();
  return (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.includes("<html") ||
    head.startsWith("<head") ||
    head.startsWith("<body")
  );
}

function isMostlyText(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let suspicious = 0;
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (const byte of sample) {
    if (byte === 0) return false;
    // Allow common whitespace/control; flag other C0 controls.
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length < 0.02;
}

function looksLikeCsv(buf: Buffer): boolean {
  if (!isMostlyText(buf) || looksLikeHtml(buf)) return false;
  const text = buf.subarray(0, Math.min(buf.length, 8192)).toString("utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const delimiterScores = [",", ";", "\t"].map((d) => {
    const counts = lines.slice(0, 20).map((l) => l.split(d).length - 1);
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    return avg;
  });
  return Math.max(...delimiterScores) >= 1;
}

/**
 * Detect file type from actual bytes.
 * Returns null when unsupported / unrecognized.
 */
export function detectFileType(bytes: Buffer): DetectedFileType | null {
  if (!bytes || bytes.length === 0) return null;

  if (startsWith(bytes, PDF_HEADER)) {
    return { extension: "pdf", mime_type: "application/pdf", confidence: "high" };
  }

  if (startsWith(bytes, PNG_HEADER)) {
    return { extension: "png", mime_type: "image/png", confidence: "high" };
  }

  if (startsWith(bytes, JPEG_SOI)) {
    return { extension: "jpg", mime_type: "image/jpeg", confidence: "high" };
  }

  if (startsWith(bytes, OLE_CFB_HEADER)) {
    // OLE Compound File — classic .xls (also used by some other Office docs).
    // Accept as xls for bank-statement ingestion.
    return {
      extension: "xls",
      mime_type: "application/vnd.ms-excel",
      confidence: "medium",
    };
  }

  if (startsWith(bytes, ZIP_LOCAL_FILE_HEADER)) {
    // XLSX is a ZIP package; require spreadsheet markers to avoid accepting arbitrary ZIPs.
    const isXlsx =
      bufferIncludesAscii(bytes, "[Content_Types].xml") ||
      bufferIncludesAscii(bytes, "xl/") ||
      bufferIncludesAscii(bytes, "xl\\");
    if (isXlsx) {
      return {
        extension: "xlsx",
        mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        confidence: "high",
      };
    }
    return null;
  }

  if (looksLikeHtml(bytes)) {
    return null;
  }

  if (looksLikeCsv(bytes)) {
    return { extension: "csv", mime_type: "text/csv", confidence: "medium" };
  }

  return null;
}

export function isSupportedDetectedType(type: DetectedFileType | null): type is DetectedFileType {
  return type != null;
}
