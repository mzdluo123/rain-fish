import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createAgent } from "../src/agent.js";
import { makeEnv } from "./helpers.js";

const env = makeEnv();
let tools: Map<string, { execute: (id: string, args: never) => Promise<{ content: { type: string; text?: string }[] }> }>;

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await tools.get(name)!.execute("t", args as never);
  return res.content.map((c) => c.text ?? "").join("");
}

beforeAll(async () => {
  const { session } = await createAgent(env);
  tools = new Map(session.agent.state.tools.map((t) => [t.name, t as never]));
});

describe("file tools work on the database", () => {
  it("write -> read -> edit -> ls -> find round trip, stored only in the files table", async () => {
    await call("write", { path: "notes/a.txt", content: "hello world\nsecond line" });
    expect(env.fs.readText("/notes/a.txt")).toBe("hello world\nsecond line");
    expect(await call("read", { path: "/notes/a.txt" })).toContain("hello world");
    await call("edit", { path: "notes/a.txt", edits: [{ oldText: "hello", newText: "bye" }] });
    expect(env.fs.readText("/notes/a.txt")).toBe("bye world\nsecond line");
    expect(await call("ls", { path: "/" })).toMatch(/notes\//);
    expect(await call("ls", { path: "/notes" })).toContain("a.txt");
    expect(await call("find", { pattern: "*.txt" })).toBe("notes/a.txt");
    expect(await call("find", { pattern: "*.txt", path: "/notes" })).toBe("a.txt");
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
    const leak = `/tmp/vfs-leak-${crypto.randomUUID()}.txt`;
    await call("write", { path: leak, content: "x" });
    expect(env.fs.readText(leak)).toBe("x");
    expect(existsSync(leak)).toBe(false);
    await call("write", { path: "../../etc/vfs-escape.txt", content: "x" });
    expect(env.fs.exists("/etc/vfs-escape.txt")).toBe(true);
    expect(existsSync("/etc/vfs-escape.txt")).toBe(false);
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
