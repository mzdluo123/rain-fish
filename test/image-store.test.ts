import { describe, expect, it } from "bun:test";
import { openDb } from "../src/db/open.js";
import { ImageStore, imageRef, parseImageRef } from "../src/image-store.js";

const bytes = (...b: number[]) => Uint8Array.from(b);

describe("ImageStore", () => {
  it("stores identical bytes once and links every message to the same id", () => {
    const s = new ImageStore(openDb(":memory:"));
    const a = s.put("100", "m1", 0, bytes(1, 2, 3), "image/png");
    const b = s.put("100", "m2", 0, bytes(1, 2, 3), "image/png");
    const c = s.put("100", "m2", 1, bytes(9), "image/png");
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(s.idsOf("100", "m2")).toEqual([a, c]);
    expect(s.totalBytes()).toBe(4);
    expect(s.get("100", a)?.data).toEqual(Buffer.from([1, 2, 3]));
  });

  it("a group only sees pictures its own messages carried", () => {
    const s = new ImageStore(openDb(":memory:"));
    const id = s.put("100", "m1", 0, bytes(1), "image/png");
    expect(s.get("200", id)).toBeUndefined();
    s.put("200", "x", 0, bytes(1), "image/png"); // the same picture shows up in group 200 too
    expect(s.get("200", id)?.id).toBe(id);
  });

  it("evicts the least recently used pictures and their links", () => {
    const db = openDb(":memory:");
    const s = new ImageStore(db);
    const old = s.put("100", "m1", 0, bytes(1, 1, 1, 1), "image/png");
    const mid = s.put("100", "m2", 0, bytes(2, 2, 2, 2), "image/png");
    const fresh = s.put("100", "m3", 0, bytes(3, 3, 3, 3), "image/png");
    db.query("UPDATE images SET last_used = ? WHERE id = ?").run(1, old);
    db.query("UPDATE images SET last_used = ? WHERE id = ?").run(2, mid);
    db.query("UPDATE images SET last_used = ? WHERE id = ?").run(3, fresh);
    expect(s.evict(8)).toBe(1);
    expect(s.get("100", old)).toBeUndefined();
    expect(s.idsOf("100", "m1")).toEqual([]);
    expect(s.get("100", mid)).toBeDefined();
    expect(s.evict(8)).toBe(0);
  });

  it("names pictures i<id>", () => {
    expect(imageRef(42)).toBe("i42");
    expect(parseImageRef(" i42 ")).toBe(42);
    expect(parseImageRef("42")).toBe(42);
    expect(parseImageRef("x42")).toBeUndefined();
    expect(parseImageRef("i-1")).toBeUndefined();
  });
});
