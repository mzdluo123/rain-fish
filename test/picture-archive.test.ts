import { describe, expect, it } from "bun:test";
import { openDb } from "../src/db/open.js";
import { ImageStore } from "../src/image-store.js";
import { createPictureArchive } from "../src/picture-archive.js";
import { imageKey } from "../src/context/image-key.js";
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
    const { images, numbers } = await attachImages(batch, source, captured, archive);
    expect(loads.length).toBe(before);
    expect(images).toHaveLength(2);
    const ids = captured.map((row) => row.map((x) => x!.id));
    const text = formatBatch(batch, numbers, false, ids);
    expect(text).toContain(`images="1,2"`);
    expect(text).toContain(`image_ids="i${ids[0]![0]},i${ids[0]![1]}"`);
    expect(formatPrompt(batch[0]!.msg)).not.toContain("image_ids");
  });
});

describe("a picture enters the context once", () => {
  const nm = (id: string, urls: string[]) => ({ msg: msg(id, urls), addressed: false });
  const never: ImageSource = { maxPerRun: 4, load: async () => { throw new Error("must not download"); } };

  it("does not attach again a picture whose bytes are already in the context; the message keeps its id and a notice names it", async () => {
    const { archive } = setup();
    const batch = [nm("1", ["https://x/1", "https://x/2"])];
    const captured = await Promise.all(batch.map((p) => archive.capture(p.msg)));
    const first = await attachImages(batch, never, captured, archive);
    expect(first.images).toHaveLength(2);
    const ids = captured.map((row) => row.map((x) => x!.id));

    const inContext = new Set(first.images.map((i) => imageKey(i))); // what the conversation holds after that run
    const again = await attachImages(batch, never, captured, archive, inContext);
    expect(again.images).toHaveLength(0);
    expect(again.repeated.sort()).toEqual(ids[0]!.slice().sort());
    const text = formatBatch(batch, again.numbers, false, ids, again.repeated);
    expect(text).toContain(`image_ids="i${ids[0]![0]},i${ids[0]![1]}"`);
    expect(text).toContain(`图片 i${ids[0]![0]}、i${ids[0]![1]} 已在上文中`);
    expect(text).not.toContain("image(s) are attached");
  });

  it("attaches only the new one of a mixed batch, and repeats do not use up the per-run slots", async () => {
    const { archive } = setup();
    const old = nm("1", ["https://x/1"]);
    const oldPics = await archive.capture(old.msg);
    const seen = await attachImages([old], never, [oldPics], archive);
    const inContext = new Set(seen.images.map((i) => imageKey(i)));

    const batch = [nm("2", ["https://x/2"]), nm("3", ["https://x/1"]), nm("4", ["https://x/3"])]; // newest: 3 (already seen), 4
    const captured = await Promise.all(batch.map((p) => archive.capture(p.msg)));
    const r = await attachImages(batch, { ...never, maxPerRun: 2 }, captured, archive, inContext);
    expect(r.images).toHaveLength(2); // the repeat of x/1 did not take a slot: x/3 and x/2 both fit
    expect(r.numbers[1]).toEqual([]);
    expect(r.numbers[0]).toHaveLength(1);
    expect(r.numbers[2]).toHaveLength(1);
    expect(r.repeated).toEqual([oldPics[0]!.id]);
  });

  it("the same picture in two messages of a batch is attached once and numbered once", async () => {
    const { archive } = setup();
    const batch = [nm("1", ["https://x/1"]), nm("2", ["https://x/1"])];
    const captured = await Promise.all(batch.map((p) => archive.capture(p.msg)));
    const r = await attachImages(batch, never, captured, archive);
    expect(r.images).toHaveLength(1);
    expect(r.numbers).toEqual([[1], [1]]);
  });
});

describe("picture archive: model copy", () => {
  async function scaled() {
    const { createModelImage } = await import("../src/image-resize.js");
    const { pngBytes } = await import("./helpers.js");
    const original = pngBytes(1600, 1200);
    const source: ImageSource = { maxPerRun: 4, load: async () => ({ type: "image", data: original.toString("base64"), mimeType: "image/png" }) };
    const store = new ImageStore(openDb(":memory:"));
    const inner = createModelImage({ maxPixels: 100_000, maxEdge: 1568, detailMaxPixels: 200_000 });
    const calls: number[] = [];
    const archive = createPictureArchive({ source, store, maxBytes: 50_000_000, shrink: async (img, closer) => (calls.push(img.data.length), inner(img, closer)) });
    return { original, store, archive, calls };
  }

  it("stores the original and scales only when the model copy is asked for", async () => {
    const { original, store, archive, calls } = await scaled();
    const [pic] = await archive.capture(msg("1", ["https://x/a"]));
    expect(calls).toHaveLength(0); // capturing a picture does not scale it
    expect(store.get("100", pic!.id)!.data.equals(original)).toBe(true);
    const shown = await archive.image("100", pic!.id);
    expect(calls).toHaveLength(1);
    expect(Buffer.from(shown!.data, "base64").length).toBeLessThan(original.length / 4);
    expect(store.get("100", pic!.id)!.data.equals(original)).toBe(true); // the original is untouched
  });

  it("a picture another group never saw cannot be fetched", async () => {
    const { archive } = await scaled();
    const [pic] = await archive.capture(msg("1", ["https://x/a"]));
    expect(await archive.image("200", pic!.id)).toBeUndefined();
    expect(await archive.image("100", 9999)).toBeUndefined();
  });

  it("attaching scales only the pictures that are really attached (the newest maxPerRun), not the rest of the batch", async () => {
    const { archive, calls } = await scaled();
    const { attachImages } = await import("../src/responder.js");
    const batch = [{ msg: msg("1", ["https://x/a", "https://x/b", "https://x/c"]), addressed: false }];
    const captured = await Promise.all(batch.map((p) => archive.capture(p.msg)));
    expect(calls).toHaveLength(0);
    const never: ImageSource = { maxPerRun: 2, load: async () => { throw new Error("must not download"); } };
    const { images } = await attachImages(batch, never, captured, archive);
    expect(calls).toHaveLength(1); // the three pictures are the same bytes -> one picture, one scaling
    expect(images).toHaveLength(1);
  });

  it("a message whose pictures are already stored is not downloaded again (the URL may be gone)", async () => {
    const { archive, store, loads } = setup();
    const m = msg("1", ["https://x/1"]);
    const [first] = await archive.capture(m);
    expect(loads).toHaveLength(1);
    const expired: ImageSource = { maxPerRun: 4, load: async () => { throw new Error("URL expired"); } };
    const [again] = await createPictureArchive({ source: expired, store, maxBytes: 1_000_000 }).capture(m); // e.g. after a restart
    expect(again?.id).toBe(first!.id);
  });
});
