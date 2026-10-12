/**
 * PDF text extraction with page coordinates via pdfjs-dist.
 */

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { BoundingBox } from "../types.js";
import { config } from "../../../config/env.js";

const require = createRequire(import.meta.url);

export type PdfTextItem = {
  text: string;
  bbox: BoundingBox;
  page: number;
};

export type PdfPageText = {
  page: number;
  width: number;
  height: number;
  items: PdfTextItem[];
  raw_text: string;
  char_count: number;
};

export type PdfTextExtraction = {
  pages: PdfPageText[];
  page_count: number;
};

type PdfJsModule = {
  getDocument: (src: { data: Uint8Array; useSystemFonts?: boolean }) => {
    promise: Promise<PdfDocument>;
  };
  VerbosityLevel?: { ERRORS: number };
  setVerbosityLevel?: (level: number) => void;
};

type PdfDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
  destroy?: () => Promise<void>;
};

type PdfPage = {
  getViewport: (params: { scale: number }) => { width: number; height: number };
  getTextContent: () => Promise<{
    items: Array<{ str?: string; transform?: number[]; width?: number; height?: number }>;
  }>;
  cleanup?: () => void;
};

async function loadPdfJs(): Promise<PdfJsModule> {
  const resolved = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const mod = await import(pathToFileURL(resolved).href);
  return mod as PdfJsModule;
}

function itemBBox(
  transform: number[] | undefined,
  width: number | undefined,
  height: number | undefined,
  pageHeight: number,
): BoundingBox {
  const x = transform?.[4] ?? 0;
  const y = transform?.[5] ?? 0;
  const w = width ?? 0;
  const h = height ?? Math.abs(transform?.[3] ?? 10);
  // PDF origin is bottom-left; convert to top-left style for consistency with OCR.
  const yTop = pageHeight - y - h;
  return {
    x0: x,
    y0: yTop,
    x1: x + w,
    y1: yTop + h,
  };
}

export async function extractPdfText(localPath: string): Promise<PdfTextExtraction> {
  const data = new Uint8Array(await fs.readFile(localPath));
  const pdfjs = await loadPdfJs();
  if (typeof pdfjs.setVerbosityLevel === "function" && pdfjs.VerbosityLevel) {
    pdfjs.setVerbosityLevel(pdfjs.VerbosityLevel.ERRORS);
  }
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true });
  const doc = await loadingTask.promise;

  if (doc.numPages > config.maxPdfPages) {
    await doc.destroy?.();
    const err = new Error(
      `PDF has ${doc.numPages} pages which exceeds MAX_PDF_PAGES (${config.maxPdfPages})`,
    ) as Error & { code?: string };
    err.code = "DOCUMENT_LIMIT_EXCEEDED";
    throw err;
  }

  const pages: PdfPageText[] = [];

  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];

      for (const item of content.items) {
        const text = (item.str ?? "").trim();
        if (!text) continue;
        items.push({
          text,
          page: pageNum,
          bbox: itemBBox(item.transform, item.width, item.height, viewport.height),
        });
      }

      const raw_text = items.map((i) => i.text).join(" ");
      pages.push({
        page: pageNum,
        width: viewport.width,
        height: viewport.height,
        items,
        raw_text,
        char_count: raw_text.replace(/\s+/g, "").length,
      });
      page.cleanup?.();
    }
  } finally {
    await doc.destroy?.();
  }

  return { pages, page_count: pages.length };
}
