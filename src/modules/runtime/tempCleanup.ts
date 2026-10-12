/**
 * Temporary upload directory cleanup helpers.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../../config/env.js";
import { logger } from "../../config/logger.js";

export async function ensureUploadDir(): Promise<void> {
  await fs.mkdir(config.uploadDir, { recursive: true });
}

/**
 * Delete stmt_* temp uploads older than retention.
 * Default when DOCUMENT_RETENTION_HOURS=0 and RETAIN_TEMP_FILES=false: purge orphans immediately.
 */
export async function cleanupTempUploads(options?: {
  maxAgeMs?: number;
}): Promise<number> {
  const dir = config.uploadDir;
  let removed = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const maxAge =
      options?.maxAgeMs ??
      (config.documentRetentionHours > 0
        ? config.documentRetentionHours * 3_600_000
        : config.retainTempFiles
          ? Number.POSITIVE_INFINITY
          : 0); // purge stmt_* orphans immediately when retention is off

    if (!Number.isFinite(maxAge)) return 0;

    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("stmt_")) continue;
      const full = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(full);
        if (now - stat.mtimeMs >= maxAge) {
          await fs.unlink(full);
          removed += 1;
        }
      } catch {
        // ignore per-file errors
      }
    }
  } catch (err) {
    logger.warn({ err }, "temp upload cleanup skipped");
  }
  return removed;
}
