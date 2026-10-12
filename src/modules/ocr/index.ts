/**
 * OCR module stub — image / scanned PDF text recognition (future group).
 */

export type OcrRequest = {
  localPath: string;
  mimeType: string | null;
};

export type OcrResult = {
  text: string;
  confidence: number | null;
  engine: string | null;
};

export async function runOcr(_request: OcrRequest): Promise<OcrResult> {
  throw Object.assign(new Error("OCR is not implemented in Group 1"), {
    code: "OCR_NOT_IMPLEMENTED",
  });
}
