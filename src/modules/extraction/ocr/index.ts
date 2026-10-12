/**
 * OCR engine (tesseract.js) retaining page, text, bbox, and confidence.
 */

import { createWorker, type Word } from "tesseract.js";
import { preprocessImageForOcr } from "./preprocess.js";
import type { BoundingBox } from "../types.js";

export type OcrWord = {
  text: string;
  bbox: BoundingBox;
  confidence: number | null;
};

export type OcrPageResult = {
  page: number;
  raw_text: string;
  words: OcrWord[];
  mean_confidence: number | null;
};

let workerPromise: ReturnType<typeof createWorker> | null = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker("eng", 1, {
      logger: () => undefined,
    });
  }
  return workerPromise;
}

export async function terminateOcrWorker(): Promise<void> {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}

function mapWord(word: Word): OcrWord | null {
  const text = (word.text ?? "").trim();
  if (!text) return null;
  const bbox: BoundingBox = {
    x0: word.bbox.x0,
    y0: word.bbox.y0,
    x1: word.bbox.x1,
    y1: word.bbox.y1,
  };
  const confidence =
    typeof word.confidence === "number" ? Math.max(0, Math.min(1, word.confidence / 100)) : null;
  return { text, bbox, confidence };
}

export async function ocrImageBuffer(params: {
  image: Buffer;
  page?: number;
  preprocess?: boolean;
}): Promise<OcrPageResult> {
  const page = params.page ?? 1;
  const image =
    params.preprocess === false ? params.image : await preprocessImageForOcr(params.image);

  const worker = await getWorker();
  const result = await worker.recognize(image);
  const words: OcrWord[] = [];
  for (const word of result.data.words ?? []) {
    const mapped = mapWord(word);
    if (mapped) words.push(mapped);
  }

  const confidences = words
    .map((w) => w.confidence)
    .filter((c): c is number => typeof c === "number");
  const mean =
    confidences.length === 0
      ? null
      : Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(4));

  return {
    page,
    raw_text: result.data.text ?? "",
    words,
    mean_confidence: mean,
  };
}
