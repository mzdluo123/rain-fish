import { noopLogger } from "./logger.js";
import type { UploadSource, UploadSourceOptions } from "./types.js";

/** QQ file URLs sometimes use HTTP. Host paths, IP literals, credentials and alternate ports are refused. */
export function isAllowedUploadUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password && !u.port &&
      [".qq.com", ".qq.com.cn"].some((s) => u.hostname.endsWith(s));
  } catch { return false; }
}

/** Bot-owned download only. Nothing here is an agent tool or reads a host path. */
export function createUploadSource(opts: UploadSourceOptions): UploadSource {
  const log = (opts.logger ?? noopLogger).withTag("uploads");
  const doFetch = opts.fetch ?? fetch;
  return {
    async load(groupId, file) {
      if (file.size !== undefined && file.size > opts.maxBytes) return { state: "too_large", size: file.size };
      try {
        // Resolve a fresh URL after consent rather than relying on a possibly expired chat URL.
        let current = file.fileId ? await opts.resolve(groupId, file) : file.url || await opts.resolve(groupId, file);
        const signal = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
        for (let hop = 0; hop <= 3; hop++) {
          if (!isAllowedUploadUrl(current)) { log.warn("upload URL is not an allowed QQ host"); return { state: "failed" }; }
          const res = await doFetch(current, { redirect: "manual", signal });
          if (res.status >= 300 && res.status < 400) {
            await res.body?.cancel();
            const location = res.headers.get("location");
            if (!location) return { state: "failed" };
            current = new URL(location, current).toString();
            continue;
          }
          if (!res.ok) { await res.body?.cancel(); log.warn(`upload fetch failed: HTTP ${res.status}`); return { state: "failed" }; }
          const declared = Number(res.headers.get("content-length"));
          if (res.headers.has("content-length") && (!Number.isSafeInteger(declared) || declared < 0)) { await res.body?.cancel(); return { state: "failed" }; }
          if (declared > opts.maxBytes) { await res.body?.cancel(); return { state: "too_large", size: declared }; }
          const reader = res.body?.getReader();
          if (!reader) return { state: "failed" };
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > opts.maxBytes) { await reader.cancel(); return { state: "too_large", size }; }
            chunks.push(value);
          }
          if ((res.headers.has("content-length") && Number.isFinite(declared) && declared !== size) || (file.size !== undefined && file.size !== size)) {
            log.warn("upload size mismatch; original not saved");
            return { state: "failed" };
          }
          const mime = (res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream").slice(0, 120);
          return { state: "stored", data: Buffer.concat(chunks), mime };
        }
        log.warn("upload fetch failed: too many redirects");
      } catch { log.warn("upload download failed or timed out"); } // URLs may contain credentials: never log fetch errors.
      return { state: "failed" };
    },
  };
}
