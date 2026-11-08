import { createHash } from "node:crypto";

const keys = new WeakMap<object, string>();

/** Identity of a picture's bytes (not of the block object), so the same image sent twice is recognised. Cached per block: the context is re-viewed on every model call. */
export function imageKey(img: { data: string; mimeType: string }): string {
  let k = keys.get(img);
  if (!k) keys.set(img, (k = createHash("sha256").update(img.mimeType).update("\0").update(img.data).digest("hex")));
  return k;
}
