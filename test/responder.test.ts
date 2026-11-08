import { describe, expect, it } from "bun:test";
import { formatPrompt, PiResponder } from "../src/responder.js";
import type { GroupMessage } from "../src/types.js";

const msg = (groupId: string, text: string): GroupMessage => ({
  platform: "qq", groupId, messageId: "1", userId: "42", nickname: "Alice", ts: 1_700_000_000, text,
  selfId: "1", isSelf: false, mentionsSelf: true,
});

/** Minimal stand-in for an AgentSession: records prompts, replies after a delay. */
function fakeSession(log: string[], delay = 20, fail?: string) {
  const messages: unknown[] = [];
  return {
    state: { messages },
    async prompt(text: string) {
      log.push(`start ${text.split("\n")[1]}`);
      await Bun.sleep(delay);
      log.push(`end ${text.split("\n")[1]}`);
      messages.push({ role: "user" });
      messages.push(
        fail
          ? { role: "assistant", stopReason: "error", errorMessage: fail, content: [] }
          : { role: "assistant", stopReason: "stop", content: [{ type: "thinking", text: "..." }, { type: "text", text: `re:${text.split("\n")[1]}` }] },
      );
    },
  };
}

describe("formatPrompt", () => {
  it("tells the agent the group, time, speaker and text", () => {
    const p = formatPrompt(msg("100", "你好"));
    expect(p).toContain("群 100");
    expect(p).toContain("Alice(42)");
    expect(p.endsWith("\n你好")).toBe(true);
  });
});

describe("PiResponder", () => {
  it("answers messages of one group strictly one at a time, in arrival order", async () => {
    const log: string[] = [];
    const r = new PiResponder(async () => fakeSession(log) as never);
    const out = await Promise.all([r.respond(msg("1", "a")), r.respond(msg("1", "b")), r.respond(msg("1", "c"))]);
    expect(out).toEqual(["re:a", "re:b", "re:c"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("runs different groups concurrently, each with its own session", async () => {
    const log: string[] = [];
    let created = 0;
    const r = new PiResponder(async () => (created++, fakeSession(log) as never));
    await Promise.all([r.respond(msg("1", "a")), r.respond(msg("2", "b"))]);
    expect(created).toBe(2);
    expect(log.slice(0, 2).sort()).toEqual(["start a", "start b"]);
    await r.respond(msg("1", "again"));
    expect(created).toBe(2); // session reused
  });

  it("surfaces agent errors and keeps serving afterwards; retries a failed session creation", async () => {
    const log: string[] = [];
    let attempts = 0;
    const r = new PiResponder(async () => {
      if (++attempts === 1) throw new Error("no key");
      return fakeSession(log, 1) as never;
    });
    await expect(r.respond(msg("1", "a"))).rejects.toThrow("no key");
    expect(await r.respond(msg("1", "b"))).toBe("re:b");

    const bad = new PiResponder(async () => fakeSession(log, 1, "rate limited") as never);
    await expect(bad.respond(msg("1", "x"))).rejects.toThrow("rate limited");
  });
});
