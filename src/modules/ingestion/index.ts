/**
 * Ingestion service — upload + URL converge into validated DocumentInput.
 */

import { DocumentInputSchema, type DocumentInput } from "../../contracts/index.js";
import { identifyDocument } from "../document/index.js";
import { detectFileType } from "../security/fileType.js";
import { downloadRemoteDocument } from "./download.js";
import {
  generateDocumentId,
  safeUnlink,
  sanitizeOriginalFilename,
  writeDocumentFile,
} from "./storage.js";
import { createHash } from "node:crypto";
import type { AppConfig } from "../../config/env.js";
import { createErrorResponse } from "../output/index.js";
import type { ErrorResponse } from "../../contracts/index.js";

export type IngestConfig = Pick<
  AppConfig,
  | "maxUploadBytes"
  | "maxDownloadBytes"
  | "uploadDir"
  | "allowedUrlHosts"
  | "urlConnectTimeoutMs"
  | "urlDownloadTimeoutMs"
  | "urlMaxRedirects"
> & {
  allowLoopbackForTests?: boolean;
};

export type IngestResult =
  | { ok: true; document: DocumentInput }
  | { ok: false; error: ErrorResponse };

export type UploadIngestParams = {
  filename: string;
  /** Client-declared MIME — never trusted for type decisions */
  declaredMimeType?: string | null;
  buffer: Buffer;
  password?: string | null;
  metadata?: Record<string, unknown>;
};

export type UrlIngestParams = {
  url: string;
  password?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Ingest an uploaded multipart file into a local validated DocumentInput.
 */
export async function ingestUploadedFile(
  params: UploadIngestParams,
  config: IngestConfig,
): Promise<IngestResult> {
  if (!params.buffer || params.buffer.length === 0) {
    return {
      ok: false,
      error: createErrorResponse("EMPTY_UPLOAD", "Uploaded file is empty."),
    };
  }

  if (params.buffer.length > config.maxUploadBytes) {
    return {
      ok: false,
      error: createErrorResponse(
        "FILE_TOO_LARGE",
        "Uploaded file exceeds the maximum permitted size.",
      ),
    };
  }

  const detected = detectFileType(params.buffer);
  if (!detected) {
    return {
      ok: false,
      error: createErrorResponse(
        "UNSUPPORTED_FILE_TYPE",
        "Supported types: PDF, CSV, XLS, XLSX, JPG, JPEG, PNG",
      ),
    };
  }

  const documentId = generateDocumentId();
  const originalFilename = sanitizeOriginalFilename(params.filename);

  try {
    const stored = await writeDocumentFile(
      config.uploadDir,
      documentId,
      detected.extension,
      params.buffer,
    );

    const document = DocumentInputSchema.parse({
      document_id: documentId,
      source_type: "upload",
      source_url: null,
      url: null,
      original_filename: originalFilename,
      filename: originalFilename,
      mime_type: detected.mime_type,
      extension: detected.extension,
      local_path: stored.localPath,
      content_hash: stored.contentHash,
      file_size: stored.fileSize,
      size_bytes: stored.fileSize,
      password: params.password ?? null,
      metadata: {
        ...(params.metadata ?? {}),
        declared_mime_type: params.declaredMimeType ?? null,
      },
    });

    return { ok: true, document };
  } catch {
    return {
      ok: false,
      error: createErrorResponse("INGESTION_FAILED", "Failed to store uploaded file."),
    };
  }
}

/**
 * Download + validate a remote URL into the same DocumentInput shape as uploads.
 */
export async function ingestRemoteUrl(
  params: UrlIngestParams,
  config: IngestConfig,
): Promise<IngestResult> {
  return downloadRemoteDocument({
    url: params.url,
    password: params.password,
    metadata: params.metadata,
    config,
  });
}

/** Helper for tests / pre-materialized docs — does not sniff bytes. */
export function createUploadDocumentInput(params: {
  filename: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  localPath?: string | null;
  contentHash?: string | null;
  password?: string | null;
  metadata?: Record<string, unknown>;
  documentId?: string;
}): DocumentInput {
  const documentId = params.documentId ?? generateDocumentId();
  const originalFilename = sanitizeOriginalFilename(params.filename);
  return identifyDocument(
    DocumentInputSchema.parse({
      document_id: documentId,
      source_type: "upload",
      source_url: null,
      url: null,
      original_filename: originalFilename,
      filename: originalFilename,
      mime_type: params.mimeType ?? null,
      local_path: params.localPath ?? "/tmp/placeholder",
      content_hash: params.contentHash ?? null,
      file_size: params.sizeBytes ?? null,
      size_bytes: params.sizeBytes ?? null,
      password: params.password ?? null,
      metadata: params.metadata ?? {},
    }),
  );
}

/** Helper for tests — URL shell before download. */
export function createUrlDocumentInput(params: {
  url: string;
  password?: string | null;
  metadata?: Record<string, unknown>;
  documentId?: string;
  localPath?: string | null;
  mimeType?: string | null;
  extension?: string | null;
  fileSize?: number | null;
}): DocumentInput {
  const documentId = params.documentId ?? generateDocumentId();
  return identifyDocument(
    DocumentInputSchema.parse({
      document_id: documentId,
      source_type: "url",
      source_url: params.url,
      url: params.url,
      original_filename: null,
      filename: null,
      mime_type: params.mimeType ?? "application/pdf",
      extension: params.extension ?? "pdf",
      local_path: params.localPath ?? "/tmp/placeholder",
      content_hash: null,
      file_size: params.fileSize ?? 0,
      size_bytes: params.fileSize ?? 0,
      password: params.password ?? null,
      metadata: params.metadata ?? {},
    }),
  );
}

export function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export { safeUnlink, generateDocumentId, sanitizeOriginalFilename };
