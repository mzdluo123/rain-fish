import { IMAGE_TOKENS } from "./estimate-constants.js";

/** Pixel size of an image from its header (PNG, JPEG, GIF, WebP), without decoding it. `undefined` if it is not recognised. */
export function imageDimensions(b: Uint8Array): { width: number; height: number } | undefined {
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const ascii = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length < 24) return undefined;
  if (b[0] === 0x89 && ascii(1, "PNG")) {
    const width = ((b[16]! << 24) | (b[17]! << 16) | (b[18]! << 8) | b[19]!) >>> 0;
    const height = ((b[20]! << 24) | (b[21]! << 16) | (b[22]! << 8) | b[23]!) >>> 0;
    return width && height ? { width, height } : undefined;
  }
  if (ascii(0, "GIF8")) return { width: u16le(6), height: u16le(8) };
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (ascii(12, "VP8X")) return { width: u24le(24) + 1, height: u24le(27) + 1 };
    if (ascii(12, "VP8L")) {
      const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (ascii(12, "VP8 ")) return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    return undefined;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { width: u16be(i + 7), height: u16be(i + 5) };
      i += 2 + u16be(i + 2);
    }
  }
  return undefined;
}

const cache = new WeakMap<object, number>();

/**
 * Tokens one image block costs: about width x height / 750 (the major providers resize big pictures, so never more than
 * `IMAGE_TOKENS`); `IMAGE_TOKENS` when the header cannot be read. Cached per block: the context is re-measured on every call.
 */
export function imageBlockTokens(block: { data?: string }): number {
  let t = cache.get(block);
  if (t === undefined) {
    let dims: ReturnType<typeof imageDimensions>;
    try {
      dims = block.data ? imageDimensions(Buffer.from(block.data.slice(0, 131_072), "base64")) : undefined;
    } catch {
      dims = undefined;
    }
    t = dims ? Math.min(IMAGE_TOKENS, Math.max(85, Math.ceil((dims.width * dims.height) / 750))) : IMAGE_TOKENS;
    cache.set(block, t);
  }
  return t;
}
