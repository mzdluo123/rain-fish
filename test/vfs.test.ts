import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db/open.js";
import { VfsError, VirtualFs } from "../src/vfs.js";

let fs: VirtualFs;
beforeEach(() => {
  fs = new VirtualFs(openDb(":memory:"));
});
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof VfsError ? e.code : `other: ${e}`;
  }
  return "no error";
};

describe("paths", () => {
  it("resolves everything against '/', so '..' can never leave the root", () => {
    expect(VirtualFs.normalize("a/b")).toBe("/a/b");
    expect(VirtualFs.normalize("/a/../../../etc/passwd")).toBe("/etc/passwd");
    expect(VirtualFs.normalize("/a//b/./c/")).toBe("/a/b/c");
    expect(VirtualFs.normalize("")).toBe("/");
    expect(code(() => VirtualFs.normalize("/a\0b"))).toBe("EINVAL");
  });
});

describe("files", () => {
  it("writes with automatic parent directories, reads back, overwrites", () => {
    fs.writeFile("/notes/2026/a.txt", "你好");
    expect(fs.readText("/notes/2026/a.txt")).toBe("你好");
    expect(fs.stat("/notes")?.kind).toBe("dir");
    expect(fs.stat("/notes/2026/a.txt")).toMatchObject({ kind: "file", size: 6 });
    fs.writeFile("notes/2026/a.txt", "v2"); // relative path, same file
    expect(fs.readText("/notes/2026/a.txt")).toBe("v2");
    expect(fs.walk("/").filter((e) => e.kind === "file")).toHaveLength(1);
  });

  it("stores arbitrary bytes unchanged", () => {
    const bytes = new Uint8Array([0, 255, 1, 254, 0, 128]);
    fs.writeFile("/bin", bytes);
    expect(new Uint8Array(fs.readFile("/bin"))).toEqual(bytes);
  });

  it("reports POSIX-style errors for the wrong kind of path", () => {
    fs.writeFile("/f", "x");
    fs.mkdir("/d");
    expect(code(() => fs.readFile("/nope"))).toBe("ENOENT");
    expect(code(() => fs.readFile("/d"))).toBe("EISDIR");
    expect(code(() => fs.writeFile("/d", "x"))).toBe("EISDIR");
    expect(code(() => fs.writeFile("/", "x"))).toBe("EISDIR");
    expect(code(() => fs.writeFile("/f/child", "x"))).toBe("ENOTDIR");
    expect(code(() => fs.mkdir("/f"))).toBe("ENOTDIR");
    expect(code(() => fs.readdir("/f"))).toBe("ENOTDIR");
    expect(code(() => fs.readdir("/nope"))).toBe("ENOENT");
    expect(code(() => fs.remove("/"))).toBe("EBUSY");
    expect(code(() => fs.remove("/nope"))).toBe("ENOENT");
  });

  it("a failed write leaves no stray directories behind", () => {
    const small = new VirtualFs(openDb(":memory:"), { maxFileBytes: 10, maxTotalBytes: 100 });
    expect(code(() => small.writeFile("/a/b/c.txt", "x".repeat(11)))).toBe("EFBIG");
    expect(small.exists("/a")).toBe(false);
    small.writeFile("/f", "x");
    expect(code(() => small.writeFile("/f/x/y", "z"))).toBe("ENOTDIR");
    expect(small.exists("/f/x")).toBe(false);
  });
});

describe("quotas", () => {
  it("enforces the total size, counting an overwrite as a replacement", () => {
    const small = new VirtualFs(openDb(":memory:"), { maxFileBytes: 10, maxTotalBytes: 15 });
    small.writeFile("/a", "x".repeat(10));
    small.writeFile("/b", "y".repeat(5));
    expect(code(() => small.writeFile("/c", "z"))).toBe("ENOSPC");
    small.writeFile("/a", "x".repeat(10)); // replaces itself: still fits
    small.writeFile("/a", "short");
    small.writeFile("/c", "z".repeat(5)); // space freed by the shrink
  });
});

describe("readdir / walk / remove: prefix edge cases", () => {
  beforeEach(() => {
    for (const p of ["/a/x.txt", "/a/sub/y.txt", "/a.txt", "/a0", "/ab/z.txt", "/a-b"]) fs.writeFile(p, p);
  });

  it("lists only direct children of the directory, never look-alike siblings", () => {
    expect(fs.readdir("/")).toEqual(["a", "a-b", "a.txt", "a0", "ab"]);
    expect(fs.readdir("/a")).toEqual(["sub", "x.txt"]);
    expect(fs.readdir("/a/sub")).toEqual(["y.txt"]);
  });

  it("walk returns the subtree only", () => {
    expect(fs.walk("/a").map((e) => e.path)).toEqual(["/a", "/a/sub", "/a/sub/y.txt", "/a/x.txt"]);
    expect(fs.walk("/a.txt").map((e) => e.path)).toEqual(["/a.txt"]);
    expect(fs.walk("/missing")).toEqual([]);
  });

  it("remove deletes a subtree without touching look-alike siblings; non-empty needs recursive", () => {
    expect(code(() => fs.remove("/a"))).toBe("ENOTEMPTY");
    fs.remove("/a", true);
    expect(fs.readdir("/")).toEqual(["a-b", "a.txt", "a0", "ab"]);
    fs.remove("/a.txt");
    expect(fs.exists("/a.txt")).toBe(false);
  });

  it("mkdir is idempotent and creates empty directories that persist", () => {
    fs.mkdir("/empty/deep");
    fs.mkdir("/empty/deep");
    expect(fs.readdir("/empty")).toEqual(["deep"]);
    expect(fs.readdir("/empty/deep")).toEqual([]);
  });
});

describe("glob", () => {
  beforeEach(() => {
    for (const p of ["/a.md", "/notes/b.md", "/notes/deep/c.md", "/notes/d.txt", "/node_modules/x/e.md"]) fs.writeFile(p, "x");
  });

  it("a pattern without '/' matches names at any depth; with '/' it matches the relative path", () => {
    expect(fs.glob("*.md", "/")).toEqual(["/a.md", "/node_modules/x/e.md", "/notes/b.md", "/notes/deep/c.md"]);
    expect(fs.glob("notes/*.md", "/")).toEqual(["/notes/b.md"]);
    expect(fs.glob("notes/**/*.md", "/")).toEqual(["/notes/b.md", "/notes/deep/c.md"]);
    expect(fs.glob("*.md", "/notes/deep")).toEqual(["/notes/deep/c.md"]);
  });

  it("honours ignore globs and the limit, and never returns directories", () => {
    expect(fs.glob("*.md", "/", { ignore: ["**/node_modules/**"] })).toEqual(["/a.md", "/notes/b.md", "/notes/deep/c.md"]);
    expect(fs.glob("*.md", "/", { limit: 2 })).toHaveLength(2);
    expect(fs.glob("deep", "/")).toEqual([]);
  });
});

describe("persistence", () => {
  it("everything is in the one database file", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "vfs-")), "bot.db");
    const db1 = openDb(file);
    new VirtualFs(db1).writeFile("/persona.md", "- likes rain");
    db1.close();
    expect(new VirtualFs(openDb(file)).readText("/persona.md")).toBe("- likes rain");
  });
});

describe("path limits", () => {
  it("refuses over-long and over-deep paths with EINVAL and stores no parent rows", () => {
    expect(code(() => fs.writeFile(`/${"a/".repeat(5000)}x.md`, "x"))).toBe("EINVAL");
    expect(code(() => fs.writeFile(`/${"a/".repeat(40)}x.md`, "x"))).toBe("EINVAL");
    expect(code(() => fs.writeFile(`/${"b".repeat(1100)}.md`, "x"))).toBe("EINVAL");
    expect(code(() => fs.mkdir(`/${"a/".repeat(40)}`))).toBe("EINVAL");
    expect(fs.stat("/a")).toBeUndefined();
    expect(code(() => fs.writeFile(`/${"a/".repeat(30)}x.md`, "x"))).toBe("no error");
  });

  it("glob treats limit 0 or negative as 1", () => {
    fs.writeFile("/g/a.md", "x");
    fs.writeFile("/g/b.md", "x");
    expect(fs.glob("**/*.md", "/g", { limit: 0 })).toHaveLength(1);
    expect(fs.glob("**/*.md", "/g", { limit: -3 })).toHaveLength(1);
  });
});
