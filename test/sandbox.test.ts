import { readFileSync, symlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSandboxedAgent } from "../src/agent.js";
import { makeBox } from "./helpers.js";

const { tmp, box, outside } = makeBox();
let tools: Map<string, { execute: (id: string, args: never) => Promise<{ content: { type: string; text?: string }[] }> }>;

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await tools.get(name)!.execute("t", args as never);
  return res.content.map((c) => c.text ?? "").join("");
}

beforeAll(async () => {
  const { session } = await createSandboxedAgent(box);
  symlinkSync(outside, path.join(box, "link.txt"));
  symlinkSync(path.join(tmp, "nope.txt"), path.join(box, "dangling.txt"));
  tools = new Map(session.agent.state.tools.map((t) => [t.name, t as never]));
});

describe("tool set", () => {
  it("exposes exactly the file tools and no bash", () => {
    expect([...tools.keys()].sort()).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
  });
});

describe("inside the sandbox", () => {
  it("writes, reads, edits, lists, finds and greps", async () => {
    await call("write", { path: "a/b.txt", content: "hello sandbox" });
    expect(await call("read", { path: "a/b.txt" })).toMatch(/hello sandbox/);
    await call("edit", { path: "a/b.txt", edits: [{ oldText: "hello", newText: "bye" }] });
    expect(readFileSync(path.join(box, "a/b.txt"), "utf-8")).toBe("bye sandbox");
    expect(await call("ls", { path: "." })).toMatch(/a\//);
    expect(await call("find", { pattern: "**/*.txt" })).toMatch(/a\/b\.txt/);
    expect(await call("grep", { pattern: "sandbox" })).toMatch(/b\.txt/);
  });
});

describe("escape attempts are refused", () => {
  // grep reports any isDirectory() failure as "Path not found"; either way the call is refused.
  const refused = /outside the sandbox|Access denied|Path not found/;
  const cases: [string, Record<string, unknown>][] = [
    ["read", { path: outside }],
    ["read", { path: "../secret.txt" }],
    ["read", { path: "link.txt" }],
    ["write", { path: "../pwn.txt", content: "x" }],
    ["write", { path: "dangling.txt", content: "x" }],
    ["write", { path: "link.txt", content: "x" }],
    ["edit", { path: "link.txt", edits: [{ oldText: "TOP", newText: "x" }] }],
    ["ls", { path: tmp }],
    ["find", { pattern: "*", path: tmp }],
    ["grep", { pattern: "TOP", path: tmp }],
  ];
  it.each(cases)("%s %j", async (name, args) => {
    await expect(call(name, args)).rejects.toThrow(refused);
    expect(existsSync(path.join(tmp, "pwn.txt"))).toBe(false);
    expect(readFileSync(outside, "utf-8")).toBe("TOP-SECRET");
  });
});
