import { describe, expect, it } from "bun:test";
import { openDb } from "../src/db/open.js";
import { ImageStore } from "../src/image-store.js";
import { createPictureArchive } from "../src/picture-archive.js";
import { attachImages, formatBatch, formatPrompt } from "../src/responder.js";
import type { GroupMessage, ImageSource } from "../src/types.js";

const msg = (id: string, urls: string[]): GroupMessage => ({
  platform: "qq", groupId: "100", messageId: id, userId: "42", nickname: "A", ts: 1_700_000_000, text: "[图片]", selfId: "1", isSelf: false, mentionsSelf: false,
  images: urls.map((url) => ({ url })),
});
const png = (n: number) => ({ type: "image" as const, data: Buffer.from([0x89, 0x50, 0x4e, 0x47, n]).toString("base64"), mimeType: "image/png" });

function setup(maxBytes = 1_000_000) {
  const loads: string[] = [];
  const source: ImageSource = { maxPerRun: 4, load: async (url) => (loads.push(url), url.includes("bad") ? undefined : png(Number(url.slice(-1)))) };
  const store = new ImageStore(openDb(":memory:"));
  return { loads, store, archive: createPictureArchive({ source, store, maxBytes }) };
}

describe("picture archive", () => {
  it("stores the pictures of a message once, however often it is captured", async () => {
    const { archive, store, loads } = setup();
    const m = msg("1", ["https://x/1", "https://x/2"]);
    const [a, b] = await Promise.all([archive.capture(m), archive.capture(m)]);
    expect(a).toEqual(b);
    expect(loads).toHaveLength(2);
    expect(store.idsOf("100", "1")).toEqual(a.map((p) => p!.id));
  });

  it("a picture that cannot be had is undefined and does not hide its neighbours", async () => {
    const { archive } = setup();
    const r = await archive.capture(msg("1", ["https://x/bad", "https://x/2"]));
    expect(r[0]).toBeUndefined();
    expect(r[1]?.id).toBeGreaterThan(0);
  });

  it("does not keep a picture bigger than the whole budget, and evicts past it", async () => {
    const { archive, store } = setup(10);
    expect((await archive.capture(msg("1", ["https://x/1"])))[0]).toBeDefined(); // 5 bytes
    await archive.capture(msg("2", ["https://x/2"]));
    await archive.capture(msg("3", ["https://x/3"]));
    expect(store.totalBytes()).toBeLessThanOrEqual(10);
    const tiny = setup(3);
    expect((await tiny.archive.capture(msg("1", ["https://x/1"])))[0]).toBeUndefined();
  });

  it("the prompt lists the ids, and attaching uses the stored copies instead of downloading again", async () => {
    const { archive, loads } = setup();
    const batch = [{ msg: msg("1", ["https://x/1", "https://x/2"]), addressed: false }];
    const captured = await Promise.all(batch.map((p) => archive.capture(p.msg)));
    const before = loads.length;
    const source: ImageSource = { maxPerRun: 4, load: async () => { throw new Error("must not download"); } };
    const { images, numbers } = await attachImages(batch, source, captured);
    expect(loads.length).toBe(before);
    expect(images).toHaveLength(2);
    const ids = captured.map((row) => row.map((x) => x!.id));
    const text = formatBatch(batch, numbers, false, ids);
    expect(text).toContain(`images="1,2"`);
    expect(text).toContain(`image_ids="i${ids[0]![0]},i${ids[0]![1]}"`);
    expect(formatPrompt(batch[0]!.msg)).not.toContain("image_ids");
  });
});

describe("picture archive: model copy", () => {
  it("stores the original but hands the model the scaled copy", async () => {
    const { createModelImage } = await import("../src/image-resize.js");
    const { pngBytes } = await import("./helpers.js");
    const original = pngBytes(1600, 1200);
    const source: ImageSource = { maxPerRun: 4, load: async () => ({ type: "image", data: original.toString("base64"), mimeType: "image/png" }) };
    const store = new ImageStore(openDb(":memory:"));
    const archive = createPictureArchive({ source, store, maxBytes: 50_000_000, shrink: createModelImage({ maxPixels: 100_000, maxEdge: 1568, detailMaxPixels: 200_000 }) });
    const [pic] = await archive.capture(msg("1", ["https://x/a"]));
    expect(store.get("100", pic!.id)!.data.equals(original)).toBe(true);
    expect(Buffer.from(pic!.image.data, "base64").length).toBeLessThan(original.length / 4);
  });

  it("a message whose pictures are already stored is not downloaded again (the URL may be gone)", async () => {
    const { archive, store, loads } = setup();
    const m = msg("1", ["https://x/1"]);
    const [first] = await archive.capture(m);
    expect(loads).toHaveLength(1);
    const expired: ImageSource = { maxPerRun: 4, load: async () => { throw new Error("URL expired"); } };
    const [again] = await createPictureArchive({ source: expired, store, maxBytes: 1_000_000 }).capture(m); // e.g. after a restart
    expect(again?.id).toBe(first!.id);
    expect(again?.image.data).toBe(first!.image.data);
  });
});
