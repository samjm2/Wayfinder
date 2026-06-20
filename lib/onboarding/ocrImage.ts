// Server-only image normalization for the onboarding document reader.
//
// Phones and the i94.cbp.dhs.gov website hand users small, low-resolution
// screenshots (the legacy "I-94 Number Retrieval" page is ~300px wide). At that
// size a vision model can't read the small print and extraction silently fails.
//
// We upscale the long edge to a comfortable OCR size, flatten any transparency
// onto white, gently sharpen, and normalize contrast — then re-encode as PNG.
// Large/already-crisp images are left at their own resolution (we never
// downscale below the target, only up). Best-effort: on any sharp failure the
// caller falls back to the original bytes.

import sharp from "sharp";

const TARGET_LONG_EDGE = 1800; // px — comfortable for dense document text
const MAX_LONG_EDGE = 3000; // don't blow past model limits / payload size

export interface NormalizedImage {
  data: Buffer;
  mediaType: "image/png";
}

export async function normalizeImageForOcr(input: Buffer): Promise<NormalizedImage> {
  const img = sharp(input, { failOn: "none" });
  const meta = await img.metadata();
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);

  let pipeline = sharp(input, { failOn: "none" }).flatten({ background: "#ffffff" });

  // Only resize when the image is smaller than our target (upscale low-res
  // screenshots) or absurdly large (rein it in). Crisp mid-size scans pass
  // through untouched.
  if (longEdge > 0 && longEdge < TARGET_LONG_EDGE) {
    const scale = TARGET_LONG_EDGE / longEdge;
    pipeline = pipeline.resize({
      width: Math.round((meta.width ?? longEdge) * scale),
      height: Math.round((meta.height ?? longEdge) * scale),
      fit: "fill",
      kernel: "lanczos3",
    });
  } else if (longEdge > MAX_LONG_EDGE) {
    pipeline = pipeline.resize({ width: meta.width && meta.width >= (meta.height ?? 0) ? MAX_LONG_EDGE : undefined, height: meta.height && meta.height > (meta.width ?? 0) ? MAX_LONG_EDGE : undefined, fit: "inside" });
  }

  const data = await pipeline
    .sharpen() // crisp up edges blurred by upscaling
    .normalize() // stretch contrast so faint text stands out
    .png()
    .toBuffer();

  return { data, mediaType: "image/png" };
}
