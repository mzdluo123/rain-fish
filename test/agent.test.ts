import { symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_FILE, PERSONA_FILE, createSandboxedAgent } from "../src/agent.js";
import { makeBox } from "./helpers.js";

describe("agent.md system context", () => {
  it("is used as the system prompt, with hard rules still appended", async () => {
    const { box } = makeBox("# Persona\nYou are TESTBOT.");
    const { session } = await createSandboxedAgent(box);
    expect(session.systemPrompt).toContain("You are TESTBOT.");
    expect(session.systemPrompt).toContain("You cannot execute code");
  });

  it("is read fresh on each session creation", async () => {
    const { box } = makeBox("v1 PERSONA");
    writeFileSync(path.join(box, AGENT_FILE), "v2 PERSONA");
    const { session } = await createSandboxedAgent(box);
    expect(session.systemPrompt).toContain("v2 PERSONA");
    expect(session.systemPrompt).not.toContain("v1 PERSONA");
  });

  it("fails clearly when agent.md is missing", async () => {
    const { box } = makeBox(null);
    await expect(createSandboxedAgent(box)).rejects.toThrow(/Missing agent\.md/);
  });

  it("appends persona.md when present, before the hard rules", async () => {
    const { box } = makeBox();
    writeFileSync(path.join(box, PERSONA_FILE), "- catchphrase: blub blub");
    const { session } = await createSandboxedAgent(box);
    const p = session.systemPrompt;
    expect(p).toContain("catchphrase: blub blub");
    expect(p.indexOf("blub blub")).toBeLessThan(p.indexOf("Hard rules"));
  });

  it("starts fine without persona.md and adds no profile section", async () => {
    const { box } = makeBox();
    const { session } = await createSandboxedAgent(box);
    expect(session.systemPrompt).not.toContain("evolving self-profile");
  });

  it("persona.md cannot be read from outside the sandbox via symlink", async () => {
    const { box, outside } = makeBox();
    symlinkSync(outside, path.join(box, PERSONA_FILE));
    await expect(createSandboxedAgent(box)).rejects.toThrow(/outside the sandbox/);
  });
});
