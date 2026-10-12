import fs from "node:fs";
import path from "node:path";
import { ingestUploadedFile } from "../src/modules/ingestion/index.js";
import { extractIntermediate } from "../src/modules/extraction/index.js";
import { config } from "../src/config/env.js";

const filePath = path.resolve(
  "uploads/Statement_0020044889_20260928115440_260928_115627.pdf",
);

async function main() {
  const buffer = fs.readFileSync(filePath);
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
  if (!ingested.ok) process.exit(1);
  const ex = await extractIntermediate({ runId: "diag2", document: ingested.document });
  if (!ex.ok) process.exit(1);
  const p = ex.intermediate.pages[0];
  const items = p.text_items.slice(0, 40).map((i) => ({
    t: i.text,
    y: i.bbox?.y0,
    x: i.bbox?.x0,
  }));
  fs.writeFileSync(
    "uploads/extraction-items.json",
    JSON.stringify({ itemCount: p.text_items.length, sample: items }, null, 2),
  );
  process.stderr.write(`items=${p.text_items.length}\n`);
}

main();
