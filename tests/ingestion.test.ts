import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  downloadRemoteDocument,
} from "../src/modules/ingestion/download.js";
import { ingestUploadedFile, safeUnlink } from "../src/modules/ingestion/index.js";
import {
  CSV_BYTES,
  HTML_BYTES,
  JPG_BYTES,
  PDF_BYTES,
  PNG_BYTES,
  buildFakeXlsxBytes,
} from "./fileType.test.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

function createMockServer(handler: Handler): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("upload ingestion", () => {
  let uploadDir: string;

  beforeEach(async () => {
    uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "bs-upload-"));
  });

  afterEach(async () => {
    await fs.rm(uploadDir, { recursive: true, force: true });
  });

  const cases: Array<{ name: string; filename: string; bytes: Buffer; ext: string }> = [
    { name: "PDF", filename: "statement.pdf", bytes: PDF_BYTES, ext: "pdf" },
    { name: "PNG", filename: "scan.png", bytes: PNG_BYTES, ext: "png" },
    { name: "JPG", filename: "scan.jpg", bytes: JPG_BYTES, ext: "jpg" },
    { name: "CSV", filename: "ledger.csv", bytes: CSV_BYTES, ext: "csv" },
    { name: "XLSX", filename: "book.xlsx", bytes: buildFakeXlsxBytes(), ext: "xlsx" },
  ];

  for (const c of cases) {
    it(`accepts valid ${c.name} upload`, async () => {
      const result = await ingestUploadedFile(
        {
          filename: c.filename,
          declaredMimeType: "application/octet-stream",
          buffer: c.bytes,
        },
        {
          maxUploadBytes: 1_000_000,
          maxDownloadBytes: 1_000_000,
          uploadDir,
          allowedUrlHosts: [],
          urlConnectTimeoutMs: 1000,
          urlDownloadTimeoutMs: 2000,
          urlMaxRedirects: 2,
        },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.document.document_id).toMatch(/^stmt_/);
        expect(result.document.source_type).toBe("upload");
        expect(result.document.extension).toBe(c.ext);
        expect(result.document.local_path).toBeTruthy();
        expect(result.document.file_size).toBe(c.bytes.length);
        await safeUnlink(result.document.local_path);
      }
    });
  }

  it("rejects HTML upload pretending to be PDF", async () => {
    const result = await ingestUploadedFile(
      {
        filename: "statement.pdf",
        declaredMimeType: "application/pdf",
        buffer: HTML_BYTES,
      },
      {
        maxUploadBytes: 1_000_000,
        maxDownloadBytes: 1_000_000,
        uploadDir,
        allowedUrlHosts: [],
        urlConnectTimeoutMs: 1000,
        urlDownloadTimeoutMs: 2000,
        urlMaxRedirects: 2,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("UNSUPPORTED_FILE_TYPE");
    }
  });

  it("rejects oversized uploads", async () => {
    const result = await ingestUploadedFile(
      {
        filename: "big.pdf",
        buffer: PDF_BYTES,
      },
      {
        maxUploadBytes: 4,
        maxDownloadBytes: 4,
        uploadDir,
        allowedUrlHosts: [],
        urlConnectTimeoutMs: 1000,
        urlDownloadTimeoutMs: 2000,
        urlMaxRedirects: 2,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.code).toBe("FILE_TOO_LARGE");
  });
});

describe("remote URL download", () => {
  let uploadDir: string;
  let server: http.Server;
  let baseUrl: string;
  let mode:
    | "pdf"
    | "csv"
    | "xlsx"
    | "html"
    | "empty"
    | "404"
    | "403"
    | "500"
    | "redirect-ok"
    | "redirect-private"
    | "oversized"
    | "slow"
    | "too-many-redirects";

  beforeAll(async () => {
    const created = await createMockServer((req, res) => {
      const url = req.url ?? "/";

      if (mode === "redirect-private") {
        res.writeHead(302, { Location: "http://127.0.0.1/secret" });
        // After first hop we manually flip allowLoopback off in the test via
        // intermediate private target using a blocked host instead:
        res.end();
        return;
      }

      if (mode === "redirect-ok" && url === "/start") {
        res.writeHead(302, { Location: `${baseUrl}/final.pdf` });
        res.end();
        return;
      }

      if (mode === "too-many-redirects") {
        res.writeHead(302, { Location: `${baseUrl}/next` });
        res.end();
        return;
      }

      if (mode === "404" || url.endsWith("/missing")) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      if (mode === "403") {
        res.writeHead(403);
        res.end("nope");
        return;
      }
      if (mode === "500") {
        res.writeHead(500);
        res.end("err");
        return;
      }
      if (mode === "empty") {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.end();
        return;
      }
      if (mode === "html") {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.end(HTML_BYTES);
        return;
      }
      if (mode === "oversized") {
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Length": "999999",
        });
        res.end(Buffer.concat([PDF_BYTES, Buffer.alloc(200)]));
        return;
      }
      if (mode === "slow") {
        // Never end — client timeout should fire.
        res.writeHead(200, { "Content-Type": "application/pdf" });
        return;
      }
      if (mode === "csv" || url.endsWith(".csv")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(CSV_BYTES);
        return;
      }
      if (mode === "xlsx" || url.endsWith(".xlsx")) {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(buildFakeXlsxBytes());
        return;
      }

      // default pdf
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="statement.pdf"',
      });
      res.end(PDF_BYTES);
    });
    server = created.server;
    baseUrl = created.baseUrl;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "bs-dl-"));
    mode = "pdf";
  });

  afterEach(async () => {
    await fs.rm(uploadDir, { recursive: true, force: true });
  });

  function cfg(overrides: Partial<Parameters<typeof downloadRemoteDocument>[0]["config"]> = {}) {
    return {
      maxDownloadBytes: 1000,
      uploadDir,
      allowedUrlHosts: [],
      urlConnectTimeoutMs: 500,
      urlDownloadTimeoutMs: 800,
      urlMaxRedirects: 3,
      allowLoopbackForTests: true,
      ...overrides,
    };
  }

  it("downloads public PDF/CSV/XLSX content by bytes", async () => {
    mode = "pdf";
    const pdf = await downloadRemoteDocument({
      url: `${baseUrl}/statement.pdf`,
      config: cfg(),
    });
    expect(pdf.ok).toBe(true);
    if (pdf.ok) {
      expect(pdf.document.extension).toBe("pdf");
      expect(pdf.document.source_type).toBe("url");
      expect(pdf.document.local_path).toBeTruthy();
      await safeUnlink(pdf.document.local_path);
    }

    mode = "csv";
    const csv = await downloadRemoteDocument({
      url: `${baseUrl}/data.csv`,
      config: cfg(),
    });
    expect(csv.ok).toBe(true);
    if (csv.ok) {
      expect(csv.document.extension).toBe("csv");
      await safeUnlink(csv.document.local_path);
    }

    mode = "xlsx";
    const xlsx = await downloadRemoteDocument({
      url: `${baseUrl}/book.xlsx`,
      config: cfg(),
    });
    expect(xlsx.ok).toBe(true);
    if (xlsx.ok) {
      expect(xlsx.document.extension).toBe("xlsx");
      await safeUnlink(xlsx.document.local_path);
    }
  });

  it("rejects HTML pretending to be PDF", async () => {
    mode = "html";
    const result = await downloadRemoteDocument({
      url: `${baseUrl}/statement.pdf`,
      config: cfg(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.code).toBe("UNSUPPORTED_CONTENT");
  });

  it("handles 404/403/500/empty", async () => {
    mode = "404";
    expect((await downloadRemoteDocument({ url: `${baseUrl}/x`, config: cfg() })).ok).toBe(false);

    mode = "403";
    const forbidden = await downloadRemoteDocument({ url: `${baseUrl}/x`, config: cfg() });
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.error.error.code).toBe("REMOTE_FILE_FORBIDDEN");

    mode = "500";
    expect((await downloadRemoteDocument({ url: `${baseUrl}/x`, config: cfg() })).ok).toBe(false);

    mode = "empty";
    const empty = await downloadRemoteDocument({ url: `${baseUrl}/x`, config: cfg() });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.error.code).toBe("EMPTY_REMOTE_FILE");
  });

  it("rejects oversized Content-Length before accepting body", async () => {
    mode = "oversized";
    const result = await downloadRemoteDocument({
      url: `${baseUrl}/big.pdf`,
      config: cfg({ maxDownloadBytes: 50 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.code).toBe("FILE_TOO_LARGE");
  });

  it("times out on slow responses", async () => {
    mode = "slow";
    const result = await downloadRemoteDocument({
      url: `${baseUrl}/slow.pdf`,
      config: cfg({ urlDownloadTimeoutMs: 200, urlConnectTimeoutMs: 100 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["REMOTE_FILE_TIMEOUT", "REMOTE_FILE_UNAVAILABLE"]).toContain(
        result.error.error.code,
      );
    }
  });

  it("follows safe redirects and rejects too many redirects", async () => {
    mode = "redirect-ok";
    const ok = await downloadRemoteDocument({
      url: `${baseUrl}/start`,
      config: cfg(),
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) await safeUnlink(ok.document.local_path);

    mode = "too-many-redirects";
    const tooMany = await downloadRemoteDocument({
      url: `${baseUrl}/loop`,
      config: cfg({ urlMaxRedirects: 2 }),
    });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.error.code).toBe("TOO_MANY_REDIRECTS");
  });

  it("rejects redirect to private / blocked host", async () => {
    // Custom one-off server that redirects to 169.254.169.254
    const { server: redirServer, baseUrl: redirBase } = await createMockServer((_req, res) => {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
      res.end();
    });
    try {
      const result = await downloadRemoteDocument({
        url: `${redirBase}/go`,
        config: cfg(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.error.code).toBe("URL_HOST_BLOCKED");
    } finally {
      await new Promise<void>((resolve) => redirServer.close(() => resolve()));
    }
  });
});
