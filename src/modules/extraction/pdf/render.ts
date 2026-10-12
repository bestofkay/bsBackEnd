/**
 * Render PDF pages to PNG buffers for OCR.
 * Uses pdfjs-dist + @napi-rs/canvas when available; soft-fails otherwise.
 */

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { logger } from "../../../config/logger.js";

const require = createRequire(import.meta.url);

export type RenderedPage = {
  page: number;
  width: number;
  height: number;
  png: Buffer;
};

type CanvasModule = {
  createCanvas: (width: number, height: number) => {
    width: number;
    height: number;
    getContext: (type: "2d") => unknown;
    toBuffer: (mime?: string) => Buffer;
  };
};

type PdfJsModule = {
  getDocument: (src: { data: Uint8Array; useSystemFonts?: boolean }) => {
    promise: Promise<{
      numPages: number;
      getPage: (n: number) => Promise<{
        getViewport: (p: { scale: number }) => { width: number; height: number };
        render: (params: {
          canvasContext: unknown;
          viewport: { width: number; height: number };
        }) => { promise: Promise<void> };
        cleanup?: () => void;
      }>;
      destroy?: () => Promise<void>;
    }>;
  };
};

function tryLoadCanvas(): CanvasModule | null {
  try {
    return require("@napi-rs/canvas") as CanvasModule;
  } catch {
    try {
      return require("canvas") as CanvasModule;
    } catch {
      return null;
    }
  }
}

async function loadPdfJs(): Promise<PdfJsModule> {
  const resolved = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  return (await import(pathToFileURL(resolved).href)) as PdfJsModule;
}

export async function renderPdfPagesToPng(
  localPath: string,
  pagesToRender?: number[],
  scale = 2,
): Promise<RenderedPage[]> {
  const canvasMod = tryLoadCanvas();
  if (!canvasMod) {
    logger.warn("PDF page rendering unavailable — install @napi-rs/canvas for scanned PDF OCR");
    return [];
  }

  const data = new Uint8Array(await fs.readFile(localPath));
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const out: RenderedPage[] = [];

  try {
    const targets =
      pagesToRender && pagesToRender.length > 0
        ? pagesToRender
        : Array.from({ length: doc.numPages }, (_, i) => i + 1);

    for (const pageNum of targets) {
      if (pageNum < 1 || pageNum > doc.numPages) continue;
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      const canvas = canvasMod.createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      const png = canvas.toBuffer("image/png");
      out.push({
        page: pageNum,
        width: viewport.width,
        height: viewport.height,
        png,
      });
      page.cleanup?.();
    }
  } finally {
    await doc.destroy?.();
  }

  return out;
}

export function isPdfRenderingAvailable(): boolean {
  return tryLoadCanvas() != null;
}
