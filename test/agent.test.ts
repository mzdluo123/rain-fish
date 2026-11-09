import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent.js";
import { loadSystemPrompt } from "../src/conversation-factory.js";
import { seedPersona } from "../src/context/persona.js";
import { makeEnv, pngBytes } from "./helpers.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import { imageKey } from "../src/context/image-key.js";

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

  it("exposes exactly the file tools, search_messages, the picture tools and send/stop, and no bash", async () => {
    const { session } = await createAgent(makeEnv());
    expect(session.getActiveToolNames().sort()).toEqual(["edit", "find", "grep", "ls", "read", "search_messages", "send", "send_image", "stop", "view_image", "write"]);
  });

  it("hands pictures to the model as we scaled them: Pi's own resize (prompt images, tool results) is off, so their imageKey stays the same", async () => {
    const { session } = await createAgent(makeEnv());
    expect(session.settingsManager.getImageAutoResize()).toBe(false);
    const big: ImageContent = { type: "image", data: pngBytes(2600, 40).toString("base64"), mimeType: "image/png" }; // wider than Pi's 2000 px default
    // The step `session.prompt` runs on prompt images (private in Pi; exercised here because it is what would re-encode them).
    const normalize: unknown = Reflect.get(session, "_normalizePromptImages");
    if (typeof normalize !== "function") throw new Error("Pi renamed _normalizePromptImages: point this test at its prompt-image step");
    const { images } = (await normalize.call(session, [big])) as { images: ImageContent[] }; // Pi's own return shape (private, untyped)
    expect(images).toHaveLength(1);
    expect(imageKey(images[0]!)).toBe(imageKey(big));
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

  it("the shipped prompt loads, never mentions the file it lives in, and carries no persona (that is the seed's job)", () => {
    const text = loadSystemPrompt("prompts/agent.md");
    expect(text).not.toMatch(/agent\.md/);
    expect(text).not.toContain("Yukino");
    expect(readFileSync("prompts/persona.md", "utf-8")).toContain("Yukino");
  });
});

describe("seedPersona", () => {
  it("creates /persona.md from the host file once, and never overwrites what the agent has made of it", () => {
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), "seed-")), "persona.md");
    writeFileSync(f, "# 身份\n雪乃\n");
    const { fs } = makeEnv();
    expect(seedPersona(fs, f)).toBe(true);
    expect(fs.readText("/persona.md")).toBe("# 身份\n雪乃\n");
    fs.writeFile("/persona.md", "agent edit");
    expect(seedPersona(fs, f)).toBe(false);
    expect(fs.readText("/persona.md")).toBe("agent edit");
  });

  it("fails clearly when the seed file is missing", () => {
    expect(() => seedPersona(makeEnv().fs, "/nonexistent/persona.md")).toThrow(/PERSONA_SEED_FILE/);
  });
});
