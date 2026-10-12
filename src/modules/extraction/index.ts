/**
 * Document extraction orchestrator (Group 3).
 * Produces IntermediateExtraction for Group 4 consumption.
 */

import fs from "node:fs/promises";
import type { DocumentInput, ErrorResponse } from "../../contracts/index.js";
import { createErrorResponse } from "../output/index.js";
import { extractFromCsv } from "./spreadsheet/csv.js";
import { extractFromSpreadsheet } from "./spreadsheet/xlsx.js";
import { extractFromPdf } from "./pdf/index.js";
import { extractFromImage } from "./image/index.js";
import {
  DocumentExtractionResponseSchema,
  type DocumentExtractionResponse,
  type IntermediateExtraction,
} from "./types.js";
import { resolveParser } from "../parsers/index.js";

export type ExtractionContext = {
  runId: string;
  document: DocumentInput;
};

export type ExtractionOutcome =
  | { ok: true; response: DocumentExtractionResponse; intermediate: IntermediateExtraction }
  | { ok: false; error: ErrorResponse };

export async function extractIntermediate(
  ctx: ExtractionContext,
): Promise<ExtractionOutcome> {
  const { document, runId } = ctx;
  if (!document.local_path) {
    return {
      ok: false,
      error: createErrorResponse("MISSING_LOCAL_DOCUMENT", "No local document path for extraction"),
    };
  }

  try {
    await fs.access(document.local_path);
  } catch {
    return {
      ok: false,
      error: createErrorResponse("DOCUMENT_NOT_FOUND", "Local document file is missing"),
    };
  }

  const parser = resolveParser(document.extension ?? null);
  if (!parser) {
    return {
      ok: false,
      error: createErrorResponse(
        "UNSUPPORTED_FILE_TYPE",
        "Supported types: PDF, CSV, XLS, XLSX, JPG, JPEG, PNG",
      ),
    };
  }

  try {
    let intermediate: IntermediateExtraction;

    switch (parser) {
      case "csv":
        intermediate = await extractFromCsv({
          documentId: document.document_id,
          localPath: document.local_path,
          mimeType: document.mime_type,
        });
        break;
      case "xls":
      case "xlsx":
        intermediate = await extractFromSpreadsheet({
          documentId: document.document_id,
          localPath: document.local_path,
          extension: parser,
          mimeType: document.mime_type,
        });
        break;
      case "pdf":
        intermediate = await extractFromPdf({
          documentId: document.document_id,
          localPath: document.local_path,
          mimeType: document.mime_type,
        });
        break;
      case "image":
        intermediate = await extractFromImage({
          documentId: document.document_id,
          localPath: document.local_path,
          extension: (document.extension as "png" | "jpg" | "jpeg") ?? "png",
          mimeType: document.mime_type,
        });
        break;
      default:
        return {
          ok: false,
          error: createErrorResponse("UNSUPPORTED_FILE_TYPE", "Unsupported parser"),
        };
    }

    const response = DocumentExtractionResponseSchema.parse({
      success: true,
      stage: "document_extraction",
      run_id: runId,
      document_id: document.document_id,
      intermediate,
      warnings: intermediate.warnings.map((w) => ({
        code: w.code,
        message: w.message,
        path: w.page != null ? `page:${w.page}` : null,
        details: {},
      })),
    });

    return { ok: true, response, intermediate };
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: string }).code)
        : null;
    const message = err instanceof Error ? err.message : "Extraction failed";
    if (code === "DOCUMENT_LIMIT_EXCEEDED" || code === "FILE_TOO_LARGE") {
      return {
        ok: false,
        error: createErrorResponse(code, message, { group: 8 }),
      };
    }
    return {
      ok: false,
      error: createErrorResponse("EXTRACTION_FAILED", message, {
        group: 3,
      }),
    };
  }
}

/**
 * Pipeline entry used by Groups 1–3.
 * Group 3 returns document_extraction stage success (intermediate IR).
 */
export async function extractFromDocument(
  ctx: ExtractionContext,
): Promise<DocumentExtractionResponse | ErrorResponse> {
  const result = await extractIntermediate(ctx);
  if (!result.ok) return result.error;
  return result.response;
}

export * from "./types.js";
export * from "./headers.js";
