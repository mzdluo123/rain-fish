import { beforeAll, describe, expect, it } from "bun:test";
import { createAgent } from "../src/agent.js";
import { AGENT_MAX_FILE_BYTES } from "../src/vfs-ops.js";
import { makeEnv } from "./helpers.js";

const env = makeEnv();
let tools: Map<string, { execute: (id: string, args: never) => Promise<{ content: { type: string; text?: string }[] }> }>;
const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute("t", args as never);

beforeAll(async () => {
  const { session } = await createAgent(env);
  tools = new Map(session.agent.state.tools.map((t) => [t.name, t as never]));
});

describe("agent file limits: Markdown only", () => {
  it("rejects creating or overwriting anything that is not .md, and writes nothing", async () => {
    await expect(call("write", { path: "/notes.txt", content: "x" })).rejects.toThrow(/only Markdown/);
    await expect(call("write", { path: "/script.sh", content: "x" })).rejects.toThrow(/\.md/);
    await expect(call("write", { path: "/md", content: "x" })).rejects.toThrow(/\.md/);
    expect(env.fs.walk("/")).toEqual([]);
  });

  it("edit cannot modify a non-.md file either, even one that was imported from the host", async () => {
    env.fs.writeFile("/imported.txt", "hello world");
    await expect(call("edit", { path: "/imported.txt", edits: [{ oldText: "hello", newText: "bye" }] })).rejects.toThrow(/only Markdown/);
    expect(env.fs.readText("/imported.txt")).toBe("hello world");
    expect((await call("read", { path: "/imported.txt" })).content[0]!.text).toContain("hello world"); // still readable
  });

  it("accepts .md in subdirectories", async () => {
    await call("write", { path: "/members/alice.md", content: "# Alice\n喜欢热牛奶" });
    expect(env.fs.readText("/members/alice.md")).toContain("热牛奶");
  });
});

describe("agent file limits: 10 KB per file", () => {
  it("allows exactly the limit, counted in bytes (not characters)", async () => {
    await call("write", { path: "/edge.md", content: "a".repeat(AGENT_MAX_FILE_BYTES) });
    expect(env.fs.stat("/edge.md")!.size).toBe(AGENT_MAX_FILE_BYTES);
    const cjk = "字".repeat(Math.floor(AGENT_MAX_FILE_BYTES / 3) + 1); // 3 bytes each: fewer than 10240 characters, but too many bytes
    expect(cjk.length).toBeLessThan(AGENT_MAX_FILE_BYTES);
    await expect(call("write", { path: "/cjk.md", content: cjk })).rejects.toThrow(/EFBIG/);
  });

  it("tells the agent to split, keep the content, and link the pieces as a tree; nothing is written", async () => {
    const err = await call("write", { path: "/big.md", content: "x".repeat(AGENT_MAX_FILE_BYTES + 1) }).then(
      () => undefined,
      (e: Error) => e.message,
    );
    expect(err).toMatch(/10 KB/);
    expect(err).toMatch(/new \.md files/);
    expect(err).toMatch(/word for word/);
    expect(err).toMatch(/Markdown link/);
    expect(err).toMatch(/tree/);
    expect(env.fs.exists("/big.md")).toBe(false);
  });

  it("an edit that grows a file past the limit is rejected and leaves the file as it was", async () => {
    await call("write", { path: "/grow.md", content: `START ${"y".repeat(AGENT_MAX_FILE_BYTES - 10)}` });
    const before = env.fs.readText("/grow.md");
    await expect(call("edit", { path: "/grow.md", edits: [{ oldText: "START", newText: "START ".repeat(20) }] })).rejects.toThrow(/EFBIG/);
    expect(env.fs.readText("/grow.md")).toBe(before);
  });

  it("the split-and-link workflow the error asks for succeeds", async () => {
    const part = (n: number) => `${n}`.repeat(AGENT_MAX_FILE_BYTES - 100);
    await call("write", { path: "/topic/part1.md", content: part(1) });
    await call("write", { path: "/topic/part2.md", content: part(2) });
    await call("write", { path: "/topic.md", content: "# Topic\n- [part 1](/topic/part1.md)\n- [part 2](/topic/part2.md)\n" });
    expect(env.fs.readText("/topic.md")).toContain("(/topic/part2.md)");
  });
});
