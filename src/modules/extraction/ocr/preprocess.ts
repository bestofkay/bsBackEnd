/**
 * Image preprocessing for OCR: grayscale, contrast, normalize, light denoise.
 * Rotation/deskew heuristics are best-effort without a full CV stack.
 */

import sharp from "sharp";

export type PreprocessOptions = {
  targetWidth?: number;
  enhanceContrast?: boolean;
  grayscale?: boolean;
};

export async function preprocessImageForOcr(
  input: Buffer,
  options: PreprocessOptions = {},
): Promise<Buffer> {
  const targetWidth = options.targetWidth ?? 1600;
  let pipeline = sharp(input, { failOn: "none" }).rotate(); // honor EXIF orientation

  const meta = await sharp(input, { failOn: "none" }).metadata();
  const width = meta.width ?? targetWidth;
  if (width < targetWidth) {
    pipeline = pipeline.resize({
      width: targetWidth,
      withoutEnlargement: false,
      kernel: sharp.kernel.lanczos3,
    });
  } else if (width > targetWidth * 2) {
    pipeline = pipeline.resize({
      width: Math.min(width, 2400),
      withoutEnlargement: true,
    });
  }

  if (options.grayscale !== false) {
    pipeline = pipeline.grayscale();
  }

  if (options.enhanceContrast !== false) {
    pipeline = pipeline.normalize().linear(1.15, -8);
  }

  // Mild blur + sharpen approximates denoise for scanned docs.
  pipeline = pipeline.median(1).sharpen({ sigma: 0.8 });

  return pipeline.png().toBuffer();
}

export async function detectDominantRotationDegrees(input: Buffer): Promise<0 | 90 | 180 | 270> {
  // Placeholder heuristic: EXIF-oriented decode already applied in preprocess.
  // Full OSD deskew can be layered later; return 0 for Group 3 baseline.
  void input;
  return 0;
}
