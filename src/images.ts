import type { ImageContent } from "@earendil-works/pi-ai";
import { noopLogger } from "./logger.js";
import type { ImageSource, Logger } from "./types.js";

/** Hosts QQ serves chat images from. Anything else (a forged `url` in a message) is never fetched. */
const IMAGE_HOST_SUFFIXES = [".qq.com", ".qq.com.cn", ".qpic.cn", ".gtimg.cn", ".qlogo.cn"];
const MAX_REDIRECTS = 3;

export function isAllowedImageUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  return IMAGE_HOST_SUFFIXES.some((s) => u.hostname.endsWith(s));
}

/** MIME type from the file's magic bytes (the server's header is not trusted); only what the model providers accept. */
export function sniffImageMime(b: Uint8Array): string | undefined {
  const at = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && at(1, "PNG\r\n")) return "image/png";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  return undefined;
}

export interface ImageSourceOptions {
  /** Largest accepted image, bytes. */
  maxBytes: number;
  maxPerRun: number;
  timeoutMs?: number;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
  logger?: Logger;
}

/** Reads the body, giving up as soon as it passes `max` bytes. */
async function readLimited(res: Response, max: number): Promise<Uint8Array | undefined> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > max) return undefined;
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Downloads chat images for the agent. This runs in the bot, not as an agent tool: the model never chooses a URL.
 * `load` never throws; an image that cannot be had (expired URL, too big, not a picture, host not allowed) is `undefined`.
 */
export function createImageSource(opts: ImageSourceOptions): ImageSource {
  const log = (opts.logger ?? noopLogger).withTag("images");
  const doFetch = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 10_000;

  async function load(url: string): Promise<ImageContent | undefined> {
    let current = url;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!isAllowedImageUrl(current)) {
          log.warn("image url is not an https QQ host; skipped");
          return undefined;
        }
        const res = await doFetch(current, { redirect: "manual", signal: AbortSignal.timeout(timeout) });
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          current = new URL(location, current).toString();
          continue;
        }
        if (!res.ok) {
          log.warn(`image fetch failed: HTTP ${res.status}`);
          return undefined;
        }
        const bytes = await readLimited(res, opts.maxBytes);
        if (!bytes) {
          log.warn(`image skipped: empty or over ${opts.maxBytes} bytes`);
          return undefined;
        }
        const mimeType = sniffImageMime(bytes);
        if (!mimeType) {
          log.warn("image skipped: not jpeg/png/gif/webp");
          return undefined;
        }
        log.debug(`fetched image ${mimeType} ${bytes.length} bytes`);
        return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType };
      }
      log.warn("image fetch failed: too many redirects");
    } catch (err) {
      log.warn(`image fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return undefined;
  }

  return { maxPerRun: opts.maxPerRun, load };
}
