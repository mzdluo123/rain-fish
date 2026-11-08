import { symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_FILE, createSandboxedAgent } from "../src/agent.js";
import { makeBox } from "./helpers.js";

describe("agent.md system context", () => {
  it("is used as the system prompt", async () => {
    const { box } = makeBox("# Persona\nYou are TESTBOT.");
    const { session } = await createSandboxedAgent(box);
    expect(session.systemPrompt).toContain("You are TESTBOT.");
  });

  it("is read fresh on each session creation", async () => {
    const { box } = makeBox("v1 PERSONA");
    writeFileSync(path.join(box, AGENT_FILE), "v2 PERSONA");
    const { session } = await createSandboxedAgent(box);
    expect(session.systemPrompt).toContain("v2 PERSONA");
    expect(session.systemPrompt).not.toContain("v1 PERSONA");
  });

  it("is not accepted through a symlink leaving the sandbox", async () => {
    const { box, outside } = makeBox(null);
    symlinkSync(outside, path.join(box, AGENT_FILE));
    await expect(createSandboxedAgent(box)).rejects.toThrow(/outside the sandbox/);
  });

  it("fails clearly when agent.md is missing", async () => {
    const { box } = makeBox(null);
    await expect(createSandboxedAgent(box)).rejects.toThrow(/Missing agent\.md/);
  });
});
