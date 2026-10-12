import fs from "node:fs";
import path from "node:path";
import { ingestUploadedFile } from "../src/modules/ingestion/index.js";
import { extractAndPersist } from "../src/modules/api/extractService.js";
import { config } from "../src/config/env.js";
import { setForceMemoryPersistence } from "../src/modules/database/persistence.js";

setForceMemoryPersistence(true);

const filePath = path.resolve(
  "uploads/Statement_0020044889_20260928115440_260928_115627.pdf",
);
const outPath = path.resolve("uploads/extraction-result.json");

async function main() {
  const buffer = fs.readFileSync(filePath);
  process.stderr.write(`Reading ${filePath} (${buffer.length} bytes)\n`);

  const ingested = await ingestUploadedFile(
    {
      filename: path.basename(filePath),
      declaredMimeType: "application/pdf",
      buffer,
    },
    {
      maxUploadBytes: config.maxUploadBytes,
      maxDownloadBytes: config.maxDownloadBytes,
      uploadDir: config.uploadDir,
      allowedUrlHosts: config.allowedUrlHosts,
      urlConnectTimeoutMs: config.urlConnectTimeoutMs,
      urlDownloadTimeoutMs: config.urlDownloadTimeoutMs,
      urlMaxRedirects: config.urlMaxRedirects,
    },
  );

  if (!ingested.ok) {
    fs.writeFileSync(outPath, JSON.stringify(ingested.error, null, 2));
    process.stderr.write("Ingestion failed\n");
    process.exit(1);
  }

  process.stderr.write(
    `Ingested as ${ingested.document.extension} / ${ingested.document.mime_type}\n`,
  );

  const outcome = await extractAndPersist({
    document: ingested.document,
    config: {
      maxUploadBytes: config.maxUploadBytes,
      maxDownloadBytes: config.maxDownloadBytes,
      retainTempFiles: true,
    },
  });

  const body = outcome.body;
  fs.writeFileSync(outPath, JSON.stringify(body, null, 2));
  process.stderr.write(
    `Wrote ${outPath} success=${"success" in body ? body.success : false}\n`,
  );
  if (!outcome.ok) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exit(1);
});
