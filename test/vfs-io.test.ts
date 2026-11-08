import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db/open.js";
import { exportTree, importDir } from "../src/vfs-io.js";
import { VirtualFs } from "../src/vfs.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "vfsio-"));

describe("importDir / exportTree", () => {
  it("imports a host tree (including empty dirs and binary files) and exports it back identically", () => {
    const src = tmp();
    mkdirSync(path.join(src, "a/empty"), { recursive: true });
    writeFileSync(path.join(src, "agent.md"), "# 人设");
    writeFileSync(path.join(src, "a/b.bin"), Buffer.from([0, 1, 255]));
    const fs = new VirtualFs(openDb(":memory:"));
    const { written } = importDir(fs, src);
    expect(written.sort()).toEqual(["/a/b.bin", "/agent.md"]);
    expect(fs.readdir("/a")).toEqual(["b.bin", "empty"]);

    const dst = tmp();
    exportTree(fs, "/", dst);
    expect(readFileSync(path.join(dst, "agent.md"), "utf-8")).toBe("# 人设");
    expect([...readFileSync(path.join(dst, "a/b.bin"))]).toEqual([0, 1, 255]);
    expect(exportTree(fs, "/a", tmp())).toHaveLength(1);
  });

  it("never overwrites files the agent changed unless forced", () => {
    const src = tmp();
    writeFileSync(path.join(src, "agent.md"), "seed v2");
    writeFileSync(path.join(src, "new.md"), "new");
    const fs = new VirtualFs(openDb(":memory:"));
    fs.writeFile("/agent.md", "agent's own edit");
    expect(importDir(fs, src)).toEqual({ written: ["/new.md"], skipped: ["/agent.md"] });
    expect(fs.readText("/agent.md")).toBe("agent's own edit");
    expect(importDir(fs, src, { force: true }).written).toContain("/agent.md");
    expect(fs.readText("/agent.md")).toBe("seed v2");
  });
});
