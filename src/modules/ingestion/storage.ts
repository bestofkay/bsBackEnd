/**
 * Safe temporary document storage.
 * Paths are derived only from generated document IDs — never from remote filenames.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { SupportedExtension } from "../../contracts/index.js";

const DOCUMENT_ID_PREFIX = "stmt_";

export function generateDocumentId(): string {
  // Time-sortable-ish + entropy: stmt_<hex timestamp><random>
  const time = Date.now().toString(36);
  const entropy = randomBytes(10).toString("hex");
  return `${DOCUMENT_ID_PREFIX}${time}${entropy}`;
}

export function sanitizeOriginalFilename(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = path.basename(name).replace(/[^\w.\- ()[\]]+/g, "_").trim();
  if (!base || base === "." || base === "..") return null;
  return base.slice(0, 180);
}

export async function ensureUploadDir(uploadDir: string): Promise<string> {
  const absolute = path.resolve(uploadDir);
  await fs.mkdir(absolute, { recursive: true });
  return absolute;
}

export function buildStoredPath(
  uploadDir: string,
  documentId: string,
  extension: SupportedExtension,
): string {
  if (!documentId.startsWith(DOCUMENT_ID_PREFIX) || documentId.includes("..") || documentId.includes("/") || documentId.includes("\\")) {
    throw new Error("Invalid document id");
  }
  const safeExt = extension.toLowerCase().replace(/[^a-z0-9]/g, "");
  return path.join(path.resolve(uploadDir), `${documentId}.${safeExt}`);
}

export async function writeDocumentFile(
  uploadDir: string,
  documentId: string,
  extension: SupportedExtension,
  bytes: Buffer,
): Promise<{ localPath: string; contentHash: string; fileSize: number }> {
  const dir = await ensureUploadDir(uploadDir);
  const localPath = buildStoredPath(dir, documentId, extension);
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(localPath, bytes, { flag: "wx" });
  return { localPath, contentHash, fileSize: bytes.length };
}

/**
 * Stream writer with hard byte cap — used by remote downloads.
 */
export async function openCappedWriteStream(
  uploadDir: string,
  documentId: string,
  extension: SupportedExtension,
  maxBytes: number,
): Promise<{
  localPath: string;
  write: (chunk: Buffer) => Promise<void>;
  finalize: () => Promise<{ contentHash: string; fileSize: number }>;
  abort: () => Promise<void>;
}> {
  const dir = await ensureUploadDir(uploadDir);
  const localPath = buildStoredPath(dir, documentId, extension);
  const handle = await fs.open(localPath, "wx");
  const hash = createHash("sha256");
  let fileSize = 0;
  let closed = false;

  return {
    localPath,
    async write(chunk: Buffer) {
      if (closed) throw new Error("Stream already closed");
      if (fileSize + chunk.length > maxBytes) {
        const err = new Error("Maximum download size exceeded");
        (err as Error & { code?: string }).code = "FILE_TOO_LARGE";
        throw err;
      }
      hash.update(chunk);
      await handle.write(chunk);
      fileSize += chunk.length;
    },
    async finalize() {
      if (!closed) {
        await handle.close();
        closed = true;
      }
      return { contentHash: hash.digest("hex"), fileSize };
    },
    async abort() {
      if (!closed) {
        await handle.close();
        closed = true;
      }
      await safeUnlink(localPath);
    },
  };
}

export async function safeUnlink(filePath: string | null | undefined): Promise<void> {
  if (!filePath) return;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.unlink(filePath);
      return;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: string }).code)
          : "";
      if (code === "ENOENT") return;
      // Windows may briefly lock PDFs after parse; retry then give up.
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
        continue;
      }
    }
  }
}

/**
 * Rewrite file extension after sniffing (temp may have been written with a placeholder).
 */
export async function renameWithDetectedExtension(
  currentPath: string,
  uploadDir: string,
  documentId: string,
  extension: SupportedExtension,
): Promise<string> {
  const target = buildStoredPath(uploadDir, documentId, extension);
  if (path.resolve(currentPath) === path.resolve(target)) return target;
  await fs.rename(currentPath, target);
  return target;
}
