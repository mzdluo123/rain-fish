import type { ModelImageFn } from "./types.js";

/** How big a picture may be when it is shown to the model. The aspect ratio is always kept; a picture is never enlarged. */
export interface ShrinkBudget {
  /** Most pixels (width x height). Tokens are about pixels / 750. 0 = never shrink. */
  maxPixels: number;
  /** Longest side. The big providers resize anything above ~1568 px themselves. */
  maxEdge: number;
}

/** A picture with more pixels than this is not decoded at all (a small file can expand to gigabytes of pixels). */
export const MAX_DECODE_PIXELS = 60_000_000;

/** Scale factor (<= 1) that fits `width` x `height` into the budget; the same factor for both sides, so the ratio is kept. */
export function planScale(width: number, height: number, budget: ShrinkBudget): number {
  if (budget.maxPixels <= 0 || width <= 0 || height <= 0) return 1;
  return Math.min(1, Math.sqrt(budget.maxPixels / (width * height)), budget.maxEdge / Math.max(width, height));
}

/**
 * The copy of a picture that goes to the model: scaled down to the budget (JPEG stays JPEG, everything else becomes WebP, which
 * keeps transparency). Never throws: on any problem (not decodable, too many pixels, no native image support) the original is returned.
 */
export async function shrinkImage(img: { data: Buffer; mime: string }, budget: ShrinkBudget): Promise<{ data: Buffer; mime: string }> {
  try {
    const Image = (Bun as unknown as { Image?: new (b: Uint8Array) => BunImage }).Image;
    if (!Image || budget.maxPixels <= 0) return img;
    const { width, height } = await new Image(img.data).metadata();
    if (width * height > MAX_DECODE_PIXELS) return img;
    const scale = planScale(width, height, budget);
    if (scale >= 1) return img;
    const w = Math.max(1, Math.floor(width * scale)); // floor: rounding up could push the pixel count past the budget
    const h = Math.max(1, Math.floor(height * scale));
    const resized = new Image(img.data).resize(w, h);
    if (img.mime === "image/jpeg") return { data: Buffer.from(await resized.jpeg({ quality: 85 }).bytes()), mime: "image/jpeg" };
    return { data: Buffer.from(await resized.webp({ quality: 85 }).bytes()), mime: "image/webp" };
  } catch {
    return img;
  }
}

interface BunImage {
  metadata(): Promise<{ width: number; height: number; format: string }>;
  resize(w: number, h: number): BunImage;
  jpeg(o?: { quality?: number }): BunImage;
  webp(o?: { quality?: number }): BunImage;
  bytes(): Promise<Uint8Array>;
}

/** The shrinking the program uses: the normal budget for what is attached to a turn, the larger `detail` budget when the agent asks to look closely. */
export function createModelImage(opts: { maxPixels: number; maxEdge: number; detailMaxPixels: number }): ModelImageFn {
  const normal: ShrinkBudget = { maxPixels: opts.maxPixels, maxEdge: opts.maxEdge };
  const detail: ShrinkBudget = { maxPixels: Math.max(opts.detailMaxPixels, opts.maxPixels), maxEdge: opts.maxEdge };
  return (img, closer = false) => shrinkImage(img, closer ? detail : normal);
}
