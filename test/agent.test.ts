import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.js";
import { loadSystemPrompt } from "../src/conversation-factory.js";
import { makeEnv } from "./helpers.js";

describe("agent", () => {
  it("uses the given text verbatim as the system prompt", async () => {
    const { session } = await createAgent(makeEnv("# Persona\nYou are TESTBOT."));
    expect(session.systemPrompt).toContain("# Persona\nYou are TESTBOT.");
  });

  it("the prompt is not in the agent's filesystem, so the agent can neither read nor change it", async () => {
    const env = makeEnv("SECRET-PERSONA-TEXT");
    const { session } = await createAgent(env);
    expect(env.fs.walk("/")).toEqual([]);
    const read = session.agent.state.tools.find((t) => t.name === "read")!;
    for (const p of ["/agent.md", "agent.md", "/prompts/agent.md", "prompts/agent.md", "../prompts/agent.md"]) {
      await expect(read.execute("t", { path: p } as never)).rejects.toThrow(/ENOENT|not found/i);
    }
    const grep = session.agent.state.tools.find((t) => t.name === "grep")!;
    const res = await grep.execute("t", { pattern: "SECRET-PERSONA" } as never);
    expect(JSON.stringify(res.content)).toContain("No matches");
  });

  it("exposes exactly the file tools plus search_messages, and no bash", async () => {
    const { session } = await createAgent(makeEnv());
    expect(session.getActiveToolNames().sort()).toEqual(["edit", "find", "grep", "ls", "read", "search_messages", "write"]);
  });
});

describe("loadSystemPrompt", () => {
  const tmp = () => mkdtempSync(path.join(os.tmpdir(), "prompt-"));

  it("reads the file as is", () => {
    const f = path.join(tmp(), "p.md");
    writeFileSync(f, "你是 Yukino。\n");
    expect(loadSystemPrompt(f)).toBe("你是 Yukino。\n");
  });

  it("fails clearly for a missing, empty or whitespace-only file", () => {
    const dir = tmp();
    expect(() => loadSystemPrompt(path.join(dir, "nope.md"))).toThrow(/System prompt file not found.*PROMPT_FILE/);
    writeFileSync(path.join(dir, "empty.md"), "  \n");
    expect(() => loadSystemPrompt(path.join(dir, "empty.md"))).toThrow(/is empty/);
    expect(() => loadSystemPrompt(dir)).toThrow(/not found/); // a directory is not a prompt
  });

  it("the shipped prompt loads, and never mentions the file it lives in", () => {
    const text = loadSystemPrompt("prompts/agent.md");
    expect(text).toContain("Yukino");
    expect(text).not.toMatch(/agent\.md/);
  });
});
