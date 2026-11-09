import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createAgent } from "../src/agent.js";
import { unlinkedNotes } from "../src/context/persona.js";
import { openDb } from "../src/db/open.js";
import { VirtualFs } from "../src/vfs.js";
import { makeEnv, markSeen } from "./helpers.js";

const env = makeEnv();
let session: Awaited<ReturnType<typeof createAgent>>["session"];
let tools: Map<string, { execute: (id: string, args: never) => Promise<{ content: { type: string; text?: string }[] }> }>;

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await tools.get(name)!.execute("t", args as never);
  return res.content.map((c) => c.text ?? "").join("");
}

beforeAll(async () => {
  ({ session } = await createAgent(env));
  tools = new Map(session.agent.state.tools.map((t) => [t.name, t as never]));
});

describe("file tools work on the database", () => {
  it("write -> read -> edit -> ls -> find round trip, stored only in the files table", async () => {
    await call("write", { path: "notes/a.md", content: "hello world\nsecond line" });
    expect(env.fs.readText("/notes/a.md")).toBe("hello world\nsecond line");
    expect(await call("read", { path: "/notes/a.md" })).toContain("hello world");
    markSeen(session, "notes/a.md"); // in the real loop the read result is in the context by the next step
    await call("edit", { path: "notes/a.md", edits: [{ oldText: "hello", newText: "bye" }] });
    expect(env.fs.readText("/notes/a.md")).toBe("bye world\nsecond line");
    expect(await call("ls", { path: "/" })).toMatch(/notes\//);
    expect(await call("ls", { path: "/notes" })).toContain("a.md");
    expect(await call("find", { pattern: "*.md" })).toBe("notes/a.md");
    expect(await call("find", { pattern: "*.md", path: "/notes" })).toBe("a.md");
    expect(await call("find", { pattern: "*.zip" })).toMatch(/No files found/);
  });

  it("reports missing paths as errors", async () => {
    await expect(call("read", { path: "/nope.txt" })).rejects.toThrow(/ENOENT|not found/i);
    await expect(call("ls", { path: "/nope" })).rejects.toThrow(/not found|ENOENT/i);
    await expect(call("find", { pattern: "*", path: "/nope" })).rejects.toThrow(/Path not found/);
    await expect(call("grep", { pattern: "x", path: "/nope" })).rejects.toThrow(/Path not found/);
  });
});

describe("the host disk is unreachable", () => {
  it("absolute and '..' paths resolve inside the virtual root, never to host files", async () => {
    expect(existsSync("/etc/passwd")).toBe(true); // exists on the host...
    await expect(call("read", { path: "/etc/passwd" })).rejects.toThrow(/ENOENT|not found/i);
    await expect(call("read", { path: "../../../etc/passwd" })).rejects.toThrow(/ENOENT|not found/i);
    expect(await call("find", { pattern: "passwd" })).toMatch(/No files found/);
    expect(await call("grep", { pattern: "root" })).not.toMatch(/etc\/passwd/);
  });

  it("writes outside the working area land in the database, not on the host", async () => {
    const leak = `/tmp/vfs-leak-${crypto.randomUUID()}.md`;
    await call("write", { path: leak, content: "x" });
    expect(env.fs.readText(leak)).toBe("x");
    expect(existsSync(leak)).toBe(false);
    await call("write", { path: "../../etc/vfs-escape.md", content: "x" });
    expect(env.fs.exists("/etc/vfs-escape.md")).toBe(true);
    expect(existsSync("/etc/vfs-escape.md")).toBe(false);
    expect(readFileSync("/etc/passwd", "utf-8")).toContain("root"); // host file untouched
  });
});

describe("grep over database files", () => {
  beforeAll(() => {
    env.fs.writeFile("/g/one.md", "Alpha beta\nGamma delta\nalpha again\nlast line");
    env.fs.writeFile("/g/sub/two.txt", "nothing here\nALPHA upper");
    env.fs.writeFile("/g/bin.dat", new Uint8Array([97, 108, 112, 104, 97, 0, 1, 2])); // "alpha\0.."
    env.fs.writeFile("/g/regex.txt", "a.c\nabc");
  });

  it("finds matches with relative paths and line numbers, skipping binary files", async () => {
    expect(await call("grep", { pattern: "alpha", path: "/g" })).toBe("one.md:3: alpha again");
    expect(await call("grep", { pattern: "alpha", path: "/g", ignoreCase: true })).toBe(
      ["one.md:1: Alpha beta", "one.md:3: alpha again", "sub/two.txt:2: ALPHA upper"].join("\n"),
    );
  });

  it("supports glob filters, a single-file path, literal mode and regexes", async () => {
    expect(await call("grep", { pattern: "alpha", path: "/g", ignoreCase: true, glob: "*.txt" })).toBe("sub/two.txt:2: ALPHA upper");
    expect(await call("grep", { pattern: "delta", path: "/g/one.md" })).toBe("one.md:2: Gamma delta");
    expect(await call("grep", { pattern: "a.c", path: "/g/regex.txt" })).toBe("regex.txt:1: a.c\nregex.txt:2: abc");
    expect(await call("grep", { pattern: "a.c", path: "/g/regex.txt", literal: true })).toBe("regex.txt:1: a.c");
    expect(await call("grep", { pattern: "zzz", path: "/g" })).toBe("No matches found");
  });

  it("shows context lines without duplicating overlapping ones, and honours the limit", async () => {
    expect(await call("grep", { pattern: "beta|alpha again", path: "/g/one.md", context: 1 })).toBe(
      ["one.md:1: Alpha beta", "one.md-2- Gamma delta", "one.md:3: alpha again", "one.md-4- last line"].join("\n"),
    );
    const limited = await call("grep", { pattern: "a", path: "/g/one.md", limit: 1 });
    expect(limited).toMatch(/^one\.md:1: .*\n\n\[1 matches limit reached/);
  });

  it("rejects an invalid regex with a clear error", async () => {
    await expect(call("grep", { pattern: "(", path: "/g" })).rejects.toThrow(/Invalid regex/);
  });
});

describe("personaTree", () => {
  it("is the entry file plus the notes linked from it, however deep", async () => {
    const { personaTree } = await import("../src/context/persona.js");
    const { VirtualFs } = await import("../src/vfs.js");
    const { openDb } = await import("../src/db/open.js");
    const fs = new VirtualFs(openDb(":memory:"));
    fs.mkdir("/members");
    fs.mkdir("/other");
    fs.writeFile("/persona.md", "# 我\n- [喜好](/members/likes.md)\n- [群规](/rules.md) （还没写）\n");
    fs.writeFile("/members/likes.md", "细节在 [牛奶](/members/milk.md)，回到 [我](/persona.md)\n");
    fs.writeFile("/members/milk.md", "热的");
    fs.writeFile("/other/unrelated.md", "与档案无关");
    const tree = personaTree(fs);
    expect([...tree].sort()).toEqual(["/members/likes.md", "/members/milk.md", "/persona.md", "/rules.md"]);
    expect(personaTree(new VirtualFs(openDb(":memory:"))).has("/persona.md")).toBe(true); // even before the file exists
  });
});

describe("unlinkedNotes", () => {
  it("lists every .md file that cannot be reached from /persona.md by links, /wake-rules.md included; a cycle does not hide anything", () => {
    const fs = new VirtualFs(openDb(":memory:"));
    fs.writeFile("/persona.md", "[喜好](/members/likes.md)");
    fs.writeFile("/members/likes.md", "[回去](/persona.md) [牛奶](/members/milk.md)");
    fs.writeFile("/members/milk.md", "热的");
    fs.writeFile("/wake-rules.md", "| 规则 |");
    fs.writeFile("/other/b.md", "[a](/other/a.md)"); // a pair that only link each other
    fs.writeFile("/other/a.md", "[b](/other/b.md)");
    expect(unlinkedNotes(fs)).toEqual(["/other/a.md", "/other/b.md", "/wake-rules.md"]);
    fs.writeFile("/persona.md", "[喜好](/members/likes.md) [其他](/other/a.md) [唤醒](/wake-rules.md)");
    expect(unlinkedNotes(fs)).toEqual([]);
  });

  it("covers .py scripts as well: they must be linked from a note; links inside a script are not followed; the archive tree stays .md", async () => {
    const { personaTree } = await import("../src/context/persona.js");
    const fs = new VirtualFs(openDb(":memory:"));
    fs.writeFile("/persona.md", "[脚本](/scripts/a.py)");
    fs.writeFile("/scripts/a.py", "# [x](/scripts/hidden.md)\nprint(1)");
    fs.writeFile("/scripts/b.py", "print(2)");
    fs.writeFile("/scripts/hidden.md", "only linked from code");
    fs.writeFile("/data.txt", "not a note");
    expect(unlinkedNotes(fs)).toEqual(["/scripts/b.py", "/scripts/hidden.md"]);
    expect([...personaTree(fs)]).toEqual(["/persona.md"]);
  });
});
