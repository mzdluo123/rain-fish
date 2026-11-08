import { describe, expect, it } from "bun:test";
import { formatPrompt, PiResponder } from "../src/responder.js";
import type { Conversation, GroupMessage } from "../src/types.js";

const msg = (groupId: string, text: string): GroupMessage => ({
  platform: "qq", groupId, messageId: "1", userId: "42", nickname: "Alice", ts: 1_700_000_000, text,
  selfId: "1", isSelf: false, mentionsSelf: true,
});

/** A conversation that records prompts, answers after a delay, and can fail. */
function fakeConversation(log: string[], delay = 20, fail?: string): Conversation {
  return {
    async ask(prompt) {
      const text = prompt.split("\n")[1];
      log.push(`start ${text}`);
      await Bun.sleep(delay);
      log.push(`end ${text}`);
      if (fail) throw new Error(fail);
      return `re:${text}`;
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
    const r = new PiResponder(async () => fakeConversation(log));
    const out = await Promise.all([r.respond(msg("1", "a")), r.respond(msg("1", "b")), r.respond(msg("1", "c"))]);
    expect(out).toEqual(["re:a", "re:b", "re:c"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("runs different groups concurrently, each with its own conversation, reused afterwards", async () => {
    const log: string[] = [];
    let created = 0;
    const r = new PiResponder(async () => (created++, fakeConversation(log)));
    await Promise.all([r.respond(msg("1", "a")), r.respond(msg("2", "b"))]);
    expect(created).toBe(2);
    expect(log.slice(0, 2).sort()).toEqual(["start a", "start b"]);
    await r.respond(msg("1", "again"));
    expect(created).toBe(2);
  });

  it("surfaces errors, keeps serving the group afterwards, and retries a failed conversation creation", async () => {
    const log: string[] = [];
    let attempts = 0;
    const r = new PiResponder(async () => {
      if (++attempts === 1) throw new Error("no key");
      return fakeConversation(log, 1);
    });
    await expect(r.respond(msg("1", "a"))).rejects.toThrow("no key");
    expect(await r.respond(msg("1", "b"))).toBe("re:b");

    const bad = new PiResponder(async () => fakeConversation(log, 1, "rate limited"));
    await expect(bad.respond(msg("1", "x"))).rejects.toThrow("rate limited");
    await expect(bad.respond(msg("1", "y"))).rejects.toThrow("rate limited");
  });
});
