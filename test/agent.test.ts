import { describe, expect, it } from "bun:test";
import { createAgent } from "../src/agent.js";
import { makeEnv } from "./helpers.js";

describe("agent", () => {
  it("uses /agent.md from the database as the system prompt", async () => {
    const { session } = await createAgent(makeEnv("# Persona\nYou are TESTBOT."));
    expect(session.systemPrompt).toContain("You are TESTBOT.");
  });

  it("reads /agent.md fresh on each session creation", async () => {
    const env = makeEnv("v1 PERSONA");
    env.fs.writeFile("/agent.md", "v2 PERSONA");
    const { session } = await createAgent(env);
    expect(session.systemPrompt).toContain("v2 PERSONA");
    expect(session.systemPrompt).not.toContain("v1 PERSONA");
  });

  it("fails with the seeding hint when /agent.md is missing, and does not treat a directory as the prompt", async () => {
    await expect(createAgent(makeEnv(null))).rejects.toThrow(/Missing \/agent\.md.*fs import/);
    const env = makeEnv(null);
    env.fs.mkdir("/agent.md");
    await expect(createAgent(env)).rejects.toThrow(); // EISDIR on read, never a bogus prompt
  });

  it("exposes exactly the file tools plus search_messages, and no bash", async () => {
    const { session } = await createAgent(makeEnv());
    expect(session.getActiveToolNames().sort()).toEqual(["edit", "find", "grep", "ls", "read", "search_messages", "write"]);
  });
});
