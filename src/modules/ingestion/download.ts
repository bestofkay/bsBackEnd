/**
 * SSRF-safe remote document downloader.
 * - Validates URL + DNS + resolved IPs before connect
 * - Re-validates every redirect destination
 * - Enforces connect/download timeouts, redirect cap, and max size
 * - Streams to disk (never buffers unlimited responses in memory)
 */

import http from "node:http";
import https from "node:https";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { finished } from "node:stream/promises";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AppConfig } from "../../config/env.js";
import { createErrorResponse } from "../output/index.js";
import type { ErrorResponse } from "../../contracts/index.js";
import {
  sanitizeUrlForLogs,
  validateUrlForFetch,
} from "../security/urlSafety.js";
import { detectFileType } from "../security/fileType.js";
import {
  buildStoredPath,
  ensureUploadDir,
  generateDocumentId,
  renameWithDetectedExtension,
  safeUnlink,
  sanitizeOriginalFilename,
} from "./storage.js";
import type { DocumentInput } from "../../contracts/index.js";
import { DocumentInputSchema } from "../../contracts/index.js";
import { logger } from "../../config/logger.js";

export type DownloadConfig = Pick<
  AppConfig,
  | "maxDownloadBytes"
  | "uploadDir"
  | "allowedUrlHosts"
  | "urlConnectTimeoutMs"
  | "urlDownloadTimeoutMs"
  | "urlMaxRedirects"
> & {
  allowLoopbackForTests?: boolean;
};

export type DownloadSuccess = {
  ok: true;
  document: DocumentInput;
};

export type DownloadFailure = {
  ok: false;
  error: ErrorResponse;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function unavailable(code = "REMOTE_FILE_UNAVAILABLE"): DownloadFailure {
  return {
    ok: false,
    error: createErrorResponse(
      code,
      "The statement could not be downloaded from the supplied URL.",
    ),
  };
}

function mapHttpStatus(statusCode: number): DownloadFailure {
  if (statusCode === 404) {
    return {
      ok: false,
      error: createErrorResponse(
        "REMOTE_FILE_NOT_FOUND",
        "The statement could not be downloaded from the supplied URL.",
      ),
    };
  }
  if (statusCode === 401 || statusCode === 403) {
    return {
      ok: false,
      error: createErrorResponse(
        "REMOTE_FILE_FORBIDDEN",
        "The statement could not be downloaded from the supplied URL.",
      ),
    };
  }
  if (statusCode >= 500) {
    return {
      ok: false,
      error: createErrorResponse(
        "REMOTE_FILE_UNAVAILABLE",
        "The statement could not be downloaded from the supplied URL.",
      ),
    };
  }
  return unavailable();
}

function filenameFromDisposition(header: string | undefined): string | null {
  if (!header) return null;
  const utfMatch = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utfMatch) {
    try {
      return sanitizeOriginalFilename(decodeURIComponent(utfMatch[1]));
    } catch {
      return sanitizeOriginalFilename(utfMatch[1]);
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? sanitizeOriginalFilename(plain[1]) : null;
}

function filenameFromUrlPath(url: URL): string | null {
  const base = url.pathname.split("/").filter(Boolean).pop();
  return sanitizeOriginalFilename(base ?? null);
}

async function readHead(filePath: string, bytes = 16_384): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

type FetchOnceResult =
  | { kind: "redirect"; location: string }
  | { kind: "saved"; statusCode: number; headers: IncomingMessage["headers"]; bytesWritten: number; contentHash: string }
  | { kind: "error"; error: ErrorResponse };

async function fetchOnce(params: {
  url: URL;
  resolvedAddresses: string[];
  destPath: string;
  config: DownloadConfig;
}): Promise<FetchOnceResult> {
  const { url, destPath, config } = params;
  const lib = url.protocol === "https:" ? https : http;

  return new Promise<FetchOnceResult>((resolve) => {
    let settled = false;
    const settle = (value: FetchOnceResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const hash = createHash("sha256");
    let bytesWritten = 0;
    let writeStream: ReturnType<typeof createWriteStream> | null = null;
    let timedOut = false;

    const overallTimer = setTimeout(() => {
      timedOut = true;
      req.destroy(new Error("download timeout"));
    }, config.urlDownloadTimeoutMs);

    const req = lib.request(
      url,
      {
        method: "GET",
        timeout: config.urlConnectTimeoutMs,
        headers: {
          Accept: "*/*",
          "User-Agent": "bs-app-ingestion/2.0",
        },
        // Pin to a validated address when available to reduce DNS rebinding risk.
        lookup:
          params.resolvedAddresses.length > 0
            ? (_hostname, _options, cb) => {
                const address = params.resolvedAddresses[0];
                const family = address.includes(":") ? 6 : 4;
                cb(null, address, family);
              }
            : undefined,
      },
      (res) => {
        const status = res.statusCode ?? 0;

        if (REDIRECT_STATUSES.has(status)) {
          const location = res.headers.location;
          res.resume();
          clearTimeout(overallTimer);
          if (!location) {
            settle({
              kind: "error",
              error: createErrorResponse(
                "REMOTE_FILE_UNAVAILABLE",
                "The statement could not be downloaded from the supplied URL.",
              ),
            });
            return;
          }
          settle({ kind: "redirect", location });
          return;
        }

        if (status !== 200) {
          res.resume();
          clearTimeout(overallTimer);
          settle({ kind: "error", error: mapHttpStatus(status).error });
          return;
        }

        const contentLengthHeader = res.headers["content-length"];
        if (contentLengthHeader) {
          const contentLength = Number(contentLengthHeader);
          if (Number.isFinite(contentLength) && contentLength > config.maxDownloadBytes) {
            res.destroy();
            clearTimeout(overallTimer);
            settle({
              kind: "error",
              error: createErrorResponse(
                "FILE_TOO_LARGE",
                "Remote file exceeds the maximum permitted size.",
              ),
            });
            return;
          }
        }

        writeStream = createWriteStream(destPath, { flags: "wx" });
        let oversized = false;

        res.on("data", (chunk: Buffer) => {
          if (oversized || settled) return;
          bytesWritten += chunk.length;
          if (bytesWritten > config.maxDownloadBytes) {
            oversized = true;
            res.destroy();
            writeStream?.destroy();
            return;
          }
          hash.update(chunk);
          writeStream?.write(chunk);
        });

        res.on("end", () => {
          writeStream?.end();
        });

        void finished(writeStream)
          .then(async () => {
            clearTimeout(overallTimer);
            if (timedOut) {
              await safeUnlink(destPath);
              settle({
                kind: "error",
                error: createErrorResponse(
                  "REMOTE_FILE_TIMEOUT",
                  "The statement could not be downloaded from the supplied URL.",
                ),
              });
              return;
            }
            if (oversized) {
              await safeUnlink(destPath);
              settle({
                kind: "error",
                error: createErrorResponse(
                  "FILE_TOO_LARGE",
                  "Remote file exceeds the maximum permitted size.",
                ),
              });
              return;
            }
            settle({
              kind: "saved",
              statusCode: status,
              headers: res.headers,
              bytesWritten,
              contentHash: hash.digest("hex"),
            });
          })
          .catch(async () => {
            clearTimeout(overallTimer);
            await safeUnlink(destPath);
            settle({
              kind: "error",
              error: createErrorResponse(
                "REMOTE_FILE_UNAVAILABLE",
                "The statement could not be downloaded from the supplied URL.",
              ),
            });
          });
      },
    );

    req.on("timeout", () => {
      timedOut = true;
      req.destroy(new Error("connect timeout"));
    });

    req.on("error", async () => {
      clearTimeout(overallTimer);
      await safeUnlink(destPath);
      if (timedOut) {
        settle({
          kind: "error",
          error: createErrorResponse(
            "REMOTE_FILE_TIMEOUT",
            "The statement could not be downloaded from the supplied URL.",
          ),
        });
        return;
      }
      settle({
        kind: "error",
        error: createErrorResponse(
          "REMOTE_FILE_UNAVAILABLE",
          "The statement could not be downloaded from the supplied URL.",
        ),
      });
    });

    req.end();
  });
}

export async function downloadRemoteDocument(params: {
  url: string;
  password?: string | null;
  metadata?: Record<string, unknown>;
  config: DownloadConfig;
}): Promise<DownloadSuccess | DownloadFailure> {
  const documentId = generateDocumentId();
  const uploadDir = await ensureUploadDir(params.config.uploadDir);
  // Placeholder extension until bytes are sniffed.
  let tempPath = buildStoredPath(uploadDir, documentId, "pdf");
  let currentUrl = params.url;
  let redirects = 0;
  let lastHeaders: IncomingMessage["headers"] | null = null;
  let contentHash = "";
  let bytesWritten = 0;

  try {
    while (true) {
      const safety = await validateUrlForFetch(
        currentUrl,
        params.config.allowedUrlHosts,
        params.config.allowLoopbackForTests === true,
      );
      if (!safety.ok) {
        await safeUnlink(tempPath);
        return { ok: false, error: safety.error };
      }

      logger.info(
        {
          document_id: documentId,
          host: safety.hostname,
          url: sanitizeUrlForLogs(currentUrl),
          redirect: redirects,
        },
        "fetching remote statement",
      );

      // Ensure clean target for each attempt
      await safeUnlink(tempPath);
      const result = await fetchOnce({
        url: safety.url,
        resolvedAddresses: safety.resolvedAddresses,
        destPath: tempPath,
        config: params.config,
      });

      if (result.kind === "error") {
        await safeUnlink(tempPath);
        return { ok: false, error: result.error };
      }

      if (result.kind === "redirect") {
        redirects += 1;
        if (redirects > params.config.urlMaxRedirects) {
          await safeUnlink(tempPath);
          return {
            ok: false,
            error: createErrorResponse(
              "TOO_MANY_REDIRECTS",
              "The statement could not be downloaded from the supplied URL.",
            ),
          };
        }
        // Resolve relative redirect against current URL.
        const next = new URL(result.location, safety.url).toString();
        currentUrl = next;
        continue;
      }

      // saved
      lastHeaders = result.headers;
      contentHash = result.contentHash;
      bytesWritten = result.bytesWritten;
      break;
    }

    if (bytesWritten === 0) {
      await safeUnlink(tempPath);
      return {
        ok: false,
        error: createErrorResponse(
          "EMPTY_REMOTE_FILE",
          "The statement could not be downloaded from the supplied URL.",
        ),
      };
    }

    // Sniff enough bytes for ZIP/Office package markers as well as simple magics.
    const head = await readHead(tempPath, 65_536);
    const detected = detectFileType(head);
    if (!detected) {
      await safeUnlink(tempPath);
      return {
        ok: false,
        error: createErrorResponse(
          "UNSUPPORTED_CONTENT",
          "Downloaded content is not a supported statement format.",
        ),
      };
    }

    tempPath = await renameWithDetectedExtension(
      tempPath,
      uploadDir,
      documentId,
      detected.extension,
    );

    const originalFilename =
      filenameFromDisposition(
        typeof lastHeaders?.["content-disposition"] === "string"
          ? lastHeaders["content-disposition"]
          : undefined,
      ) ?? filenameFromUrlPath(new URL(currentUrl));

    const document = DocumentInputSchema.parse({
      document_id: documentId,
      source_type: "url",
      source_url: params.url,
      url: params.url,
      original_filename: originalFilename,
      filename: originalFilename,
      mime_type: detected.mime_type,
      extension: detected.extension,
      local_path: tempPath,
      content_hash: contentHash,
      file_size: bytesWritten,
      size_bytes: bytesWritten,
      password: params.password ?? null,
      metadata: params.metadata ?? {},
    });

    return { ok: true, document };
  } catch {
    await safeUnlink(tempPath);
    return unavailable();
  }
}
