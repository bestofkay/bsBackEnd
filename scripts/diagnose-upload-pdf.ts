import fs from "node:fs";
import path from "node:path";
import { ingestUploadedFile } from "../src/modules/ingestion/index.js";
import { extractIntermediate } from "../src/modules/extraction/index.js";
import { reconstructTransactions } from "../src/modules/transactions/index.js";
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
  if (!ingested.ok) {
    fs.writeFileSync("uploads/extraction-diag.json", JSON.stringify(ingested.error, null, 2));
    process.exit(1);
  }

  const ex = await extractIntermediate({
    runId: "diag",
    document: ingested.document,
  });
  if (!ex.ok) {
    fs.writeFileSync("uploads/extraction-diag.json", JSON.stringify(ex.error, null, 2));
    process.exit(1);
  }

  const ir = ex.intermediate;
  const pagesPreview = (ir.pages || []).slice(0, 3).map((p) => ({
    page: p.page,
    kind: p.kind,
    chars: (p.raw_text || "").length,
    preview: (p.raw_text || "").slice(0, 800),
  }));
  const txs = reconstructTransactions(ir, "NGN");
  const diag = {
    method: ir.extraction_method,
    pdf_kind: ir.pdf_kind,
    page_count: ir.page_count,
    table_count: (ir.tables || []).length,
    cell_count: (ir.cells || []).length,
    warnings: ir.warnings,
    pagesPreview,
    tableHeaders: (ir.tables || []).slice(0, 2).map((t) => t.headers),
    firstTableRowSample: (ir.tables || [])[0]?.rows?.slice(0, 5).map((r) =>
      r.cells.map((c) => c.raw_text),
    ),
    reconstructed: txs.length,
    sampleTx: txs.slice(0, 5),
  };
  fs.writeFileSync("uploads/extraction-diag.json", JSON.stringify(diag, null, 2));
  process.stderr.write(`diag written pages=${ir.page_count} txs=${txs.length} method=${ir.extraction_method}\n`);
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + "\n");
  process.exit(1);
});
