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

describe("ImageStore on disk", () => {
  it("the database file shrinks again after pictures are evicted", async () => {
    const { mkdtempSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const file = path.join(mkdtempSync(path.join(tmpdir(), "rainfish-db-")), "bot.db");
    const db = openDb(file);
    const s = new ImageStore(db);
    for (let i = 0; i < 20; i++) s.put("100", `m${i}`, 0, Buffer.alloc(200_000, i + 1), "image/png"); // 4 MB
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const grown = statSync(file).size;
    expect(grown).toBeGreaterThan(3_500_000);
    expect(s.evict(400_000)).toBe(18);
    expect(s.totalBytes()).toBeLessThanOrEqual(400_000);
    expect(statSync(file).size).toBeLessThan(grown / 3);
    db.close();
  });

  it("converts a database made without incremental vacuum, keeping its data", async () => {
    const { Database } = await import("bun:sqlite");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const file = path.join(mkdtempSync(path.join(tmpdir(), "rainfish-db-")), "old.db");
    const old = new Database(file, { create: true });
    old.run("CREATE TABLE keep (x TEXT)");
    old.run("INSERT INTO keep VALUES ('still here')");
    old.close();
    const db = openDb(file);
    expect((db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum).toBe(2);
    expect((db.query("SELECT x FROM keep").get() as { x: string }).x).toBe("still here");
    db.close();
  });
});
