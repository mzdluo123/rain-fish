import { describe, expect, it } from "bun:test";
import { estimateMessageTokens } from "../src/context/estimate.js";
import { imageBlockTokens, imageDimensions } from "../src/context/image-size.js";
import { createModelImage, planScale, shrinkImage } from "../src/image-resize.js";
import { pngBytes } from "./helpers.js";

const Image = Bun.Image;
const dimsOf = (b: Uint8Array) => imageDimensions(b);

describe("planScale", () => {
  const budget = { maxPixels: 800_000, maxEdge: 1568 };
  it("never enlarges, and leaves small pictures alone", () => {
    expect(planScale(500, 500, budget)).toBe(1);
    expect(planScale(1000, 800, budget)).toBe(1); // exactly 800k pixels
  });
  it("fits the pixel budget with one factor for both sides (the ratio is kept)", () => {
    const s = planScale(4000, 3000, budget);
    expect(4000 * s * 3000 * s).toBeCloseTo(800_000, -3);
    expect(Math.floor(4000 * s) / Math.floor(3000 * s)).toBeCloseTo(4 / 3, 2);
  });
  it("the longest side is capped too, and a tall screenshot keeps more width than an edge cap alone would", () => {
    expect(planScale(8000, 100, budget)).toBeCloseTo(1568 / 8000, 6);
    const tall = planScale(1080, 3000, budget); // a long chat screenshot: ~537 wide; a plain 1024-px edge cap would leave 369
    expect(1080 * tall).toBeGreaterThan(500);
  });
  it("0 means never shrink", () => {
    expect(planScale(9000, 9000, { maxPixels: 0, maxEdge: 100 })).toBe(1);
  });
});

describe("shrinkImage", () => {
  it("scales a big picture down, keeps its ratio and turns non-JPEG into WebP", async () => {
    const png = pngBytes(2000, 1500);
    const out = await shrinkImage({ data: png, mime: "image/png" }, { maxPixels: 400_000, maxEdge: 1568 });
    expect(out.mime).toBe("image/webp");
    const d = dimsOf(out.data)!;
    expect(d.width * d.height).toBeLessThanOrEqual(400_000);
    expect(d.width / d.height).toBeCloseTo(4 / 3, 1);
    expect(out.data.length).toBeLessThan(png.length);
  });

  it("a JPEG stays a JPEG", async () => {
    const jpeg = Buffer.from(await new Image(pngBytes(1200, 900)).jpeg({ quality: 90 }).bytes());
    const out = await shrinkImage({ data: jpeg, mime: "image/jpeg" }, { maxPixels: 100_000, maxEdge: 1568 });
    expect(out.mime).toBe("image/jpeg");
    expect(dimsOf(out.data)!.width).toBeLessThan(400);
  });

  it("returns the original untouched when it already fits, is not an image, or shrinking is off", async () => {
    const small = pngBytes(100, 100);
    expect((await shrinkImage({ data: small, mime: "image/png" }, { maxPixels: 800_000, maxEdge: 1568 })).data).toBe(small);
    const junk = Buffer.from("not a picture at all, just text");
    expect((await shrinkImage({ data: junk, mime: "image/png" }, { maxPixels: 10, maxEdge: 10 })).data).toBe(junk);
    const big = pngBytes(1200, 1200);
    expect((await shrinkImage({ data: big, mime: "image/png" }, { maxPixels: 0, maxEdge: 10 })).data).toBe(big);
  });

  it("detail mode allows more pixels than the normal mode", async () => {
    const fn = createModelImage({ maxPixels: 200_000, maxEdge: 1568, detailMaxPixels: 600_000 });
    const png = pngBytes(1600, 1200);
    const normal = dimsOf((await fn({ data: png, mime: "image/png" })).data)!;
    const closer = dimsOf((await fn({ data: png, mime: "image/png" }, true)).data)!;
    expect(normal.width * normal.height).toBeLessThanOrEqual(200_000);
    expect(closer.width * closer.height).toBeGreaterThan(normal.width * normal.height * 2);
  });
});

describe("image size in the token estimate", () => {
  it("reads PNG, JPEG and WebP headers", async () => {
    const png = pngBytes(640, 480);
    expect(dimsOf(png)).toEqual({ width: 640, height: 480 });
    expect(dimsOf(Buffer.from(await new Image(png).jpeg().bytes()))).toEqual({ width: 640, height: 480 });
    expect(dimsOf(Buffer.from(await new Image(png).webp({ quality: 80 }).bytes()))).toEqual({ width: 640, height: 480 });
    expect(dimsOf(Buffer.from("garbage garbage garbage garbage"))).toBeUndefined();
  });

  it("costs about width x height / 750, capped at 3000, and 3000 when the size is unknown", () => {
    const block = (b: Buffer) => ({ type: "image" as const, data: b.toString("base64"), mimeType: "image/png" });
    expect(imageBlockTokens(block(pngBytes(768, 576)))).toBe(Math.ceil((768 * 576) / 750));
    expect(imageBlockTokens(block(pngBytes(3000, 3000)))).toBe(3000);
    expect(imageBlockTokens({ data: "AAAA" })).toBe(3000);
    const m = { role: "user" as const, content: [{ type: "text" as const, text: "" }, block(pngBytes(256, 192))], timestamp: 1 };
    expect(estimateMessageTokens(m)).toBe(85); // a floor: even a thumbnail is never free
  });
});
