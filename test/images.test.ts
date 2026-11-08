import { describe, expect, it } from "bun:test";
import { createImageSource, isAllowedImageUrl, sniffImageMime } from "../src/images.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const OK = "https://multimedia.nt.qq.com.cn/download?x=1";

/** A fetch that serves `routes` (url -> Response factory) and records what was requested. */
function fakeFetch(routes: Record<string, () => Response>) {
  const seen: string[] = [];
  const f = (async (url: string | URL | Request) => {
    seen.push(String(url));
    const route = routes[String(url)];
    if (!route) throw new Error(`unexpected ${url}`);
    return route();
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe("isAllowedImageUrl", () => {
  it("accepts https QQ hosts only", () => {
    expect(isAllowedImageUrl(OK)).toBe(true);
    expect(isAllowedImageUrl("https://gchat.qpic.cn/x")).toBe(true);
    for (const bad of ["http://gchat.qpic.cn/x", "https://evil.example/x", "https://qq.com.evil.example/x", "https://127.0.0.1/x", "https://a.qq.com:8443/x", "https://u:p@a.qq.com/x", "file:///etc/passwd", "not a url"]) {
      expect(isAllowedImageUrl(bad)).toBe(false);
    }
  });
});

describe("sniffImageMime", () => {
  it("recognises what the providers accept by magic bytes", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMime(new TextEncoder().encode("GIF89a...."))).toBe("image/gif");
    expect(sniffImageMime(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageMime(new TextEncoder().encode("<svg xmlns=...>"))).toBeUndefined();
  });
});

describe("createImageSource.load", () => {
  const source = (f: typeof fetch, maxBytes = 1000) => createImageSource({ maxBytes, maxPerRun: 4, fetch: f });

  it("returns base64 data with the sniffed type, ignoring the server's content-type", async () => {
    const { f } = fakeFetch({ [OK]: () => new Response(PNG, { headers: { "content-type": "text/html" } }) });
    expect(await source(f).load(OK)).toEqual({ type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" });
  });

  it("never fetches a host that is not allowed", async () => {
    const { f, seen } = fakeFetch({});
    expect(await source(f).load("https://evil.example/x.png")).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("follows redirects only to allowed hosts", async () => {
    const hop = "https://gchat.qpic.cn/real";
    const ok = fakeFetch({ [OK]: () => new Response(null, { status: 302, headers: { location: hop } }), [hop]: () => new Response(PNG) });
    expect((await source(ok.f).load(OK))?.mimeType).toBe("image/png");
    const bad = fakeFetch({ [OK]: () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } }) });
    expect(await source(bad.f).load(OK)).toBeUndefined();
    expect(bad.seen).toEqual([OK]);
  });

  it("skips oversized bodies (declared or streamed), non-images, errors and failures, without throwing", async () => {
    const big = new Uint8Array(2000).fill(0xff);
    expect(await source(fakeFetch({ [OK]: () => new Response(big, { headers: { "content-length": "2000" } }) }).f).load(OK)).toBeUndefined();
    const streamed = new Response(new ReadableStream({ start(c) { c.enqueue(PNG); c.enqueue(big); c.close(); } }));
    expect(await source(fakeFetch({ [OK]: () => streamed }).f).load(OK)).toBeUndefined();
    expect(await source(fakeFetch({ [OK]: () => new Response("<html>", { status: 200 }) }).f).load(OK)).toBeUndefined();
    expect(await source(fakeFetch({ [OK]: () => new Response("gone", { status: 404 }) }).f).load(OK)).toBeUndefined();
    expect(await source(fakeFetch({}).f).load(OK)).toBeUndefined(); // fetch itself throws
  });
});
