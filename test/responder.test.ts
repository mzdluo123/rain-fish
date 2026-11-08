import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { formatPrompt, PiResponder, sampleExponential, type PiResponderOptions } from "../src/responder.js";
import type { Conversation, GroupMessage } from "../src/types.js";
import { recordingLogger } from "./helpers.js";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const msg = (groupId: string, text: string, messageId = "1"): GroupMessage => ({
  platform: "qq", groupId, messageId, userId: "42", nickname: "Alice", ts: 1_700_000_000, text,
  selfId: "1", isSelf: false, mentionsSelf: false,
});

/** random() = 0.5 makes every wait exactly mean * ln 2 (~0.693 * mean), so timing is predictable. */
const opts = (chatMeanMs: number, addressedMeanMs: number, extra: Partial<PiResponderOptions> = {}): PiResponderOptions => ({
  wake: { chatMeanMs, addressedMeanMs }, random: () => 0.5, ...extra,
});

/** Lets the responder's promise chains settle (timers are driven by `jest.advanceTimersByTime`). */
async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/**
 * A conversation that records each prompt's text lines. With `hold`, a run stays open until the test
 * calls `release()`, which makes overlap observable without any real waiting.
 */
function fakeConversation(log: string[], o: { hold?: boolean; fail?: string } = {}) {
  const release: (() => void)[] = [];
  const conversation: Conversation = {
    async ask(prompt) {
      log.push(`start ${prompt.split("\n").filter((l) => l && !l.startsWith("[")).join("|")}`);
      if (o.hold) {
        const { promise, resolve } = Promise.withResolvers<void>();
        release.push(resolve);
        await promise;
      }
      log.push("end");
      if (o.fail) throw new Error(o.fail);
      return "";
    },
  };
  return { conversation, release: () => release.shift()!() };
}

describe("formatPrompt", () => {
  it("tells the agent the group, time, message id, speaker and text", () => {
    const p = formatPrompt(msg("100", "你好", "4567"));
    expect(p).not.toContain("100"); // the group is implicit
    expect(p).toContain("#4567");
    expect(p).toContain("Alice(42)");
    expect(p).not.toContain("对你说");
    expect(p.endsWith("\n你好")).toBe(true);
  });

  it("marks messages addressed to the bot", () => {
    expect(formatPrompt(msg("100", "x"), true)).toContain("【对你说】");
  });
});

describe("sampleExponential", () => {
  it("is the inverse CDF of an exponential: 0 at u=0, the mean at u=1-1/e", () => {
    expect(sampleExponential(1000, () => 0)).toBeCloseTo(0, 9);
    expect(sampleExponential(1000, () => 1 - Math.exp(-1))).toBeCloseTo(1000, 6);
  });

  it("has the requested mean and a memoryless tail (P(X > mean) = 1/e)", () => {
    const n = 100_000;
    const xs = Array.from({ length: n }, (_, i) => sampleExponential(500, () => (i + 0.5) / n));
    expect(xs.reduce((a, b) => a + b, 0) / n).toBeCloseTo(500, -1);
    expect(xs.filter((x) => x > 500).length / n).toBeCloseTo(1 / Math.E, 3);
  });
});

describe("PiResponder wake-ups", () => {
  it("does not run per message: queued messages are handled together, in order, at the wake-up", async () => {
    const log: string[] = [];
    const r = new PiResponder(async () => fakeConversation(log).conversation, opts(60, 60)); // wait ~41.6ms
    r.notify(msg("1", "a"), false);
    r.notify(msg("1", "b"), false);
    r.notify(msg("1", "c"), false);
    jest.advanceTimersByTime(30);
    await flush();
    expect(log).toEqual([]);
    jest.advanceTimersByTime(15);
    await flush();
    expect(log).toEqual(["start a|b|c", "end"]);
  });

  it("starts the clock at the first pending message; later chatter does not postpone it", async () => {
    const log: string[] = [];
    const r = new PiResponder(async () => fakeConversation(log).conversation, opts(100, 100)); // wait ~69.3ms
    r.notify(msg("1", "a"), false);
    jest.advanceTimersByTime(40);
    r.notify(msg("1", "b"), false); // a fresh draw for "b" would put the wake-up at ~109ms
    jest.advanceTimersByTime(30);
    await flush();
    expect(log).toEqual(["start a|b", "end"]);
  });

  it("a message addressed to the bot pulls the wake-up earlier, and queued chatter rides along", async () => {
    const log: string[] = [];
    const r = new PiResponder(async () => fakeConversation(log).conversation, opts(1_000_000, 10)); // addressed wait ~6.9ms
    r.notify(msg("1", "chat"), false);
    jest.advanceTimersByTime(20);
    await flush();
    expect(log).toEqual([]);
    r.notify(msg("1", "hey bot"), true);
    jest.advanceTimersByTime(7);
    await flush();
    expect(log).toEqual(["start chat|hey bot", "end"]);
  });

  it("an addressed message never delays an earlier chat wake-up", async () => {
    const log: string[] = [];
    const r = new PiResponder(async () => fakeConversation(log).conversation, opts(20, 1_000_000)); // chat ~13.9ms
    r.notify(msg("1", "chat"), false);
    r.notify(msg("1", "hey bot"), true);
    jest.advanceTimersByTime(14);
    await flush();
    expect(log).toEqual(["start chat|hey bot", "end"]);
  });

  it("runs of one group never overlap; messages arriving mid-run wait for the next wake-up", async () => {
    const log: string[] = [];
    const conv = fakeConversation(log, { hold: true });
    const r = new PiResponder(async () => conv.conversation, opts(0, 0));
    r.notify(msg("1", "a"), false);
    jest.advanceTimersByTime(1);
    await flush();
    r.notify(msg("1", "b"), false); // arrive while "a" is still running
    r.notify(msg("1", "c"), false);
    jest.advanceTimersByTime(1);
    await flush();
    expect(log).toEqual(["start a"]);
    conv.release();
    await flush();
    expect(log).toEqual(["start a", "end", "start b|c"]);
    conv.release();
    await flush();
    expect(log.at(-1)).toBe("end");
  });

  it("runs different groups concurrently, each with its own conversation, reused afterwards", async () => {
    const log: string[] = [];
    const convs: ReturnType<typeof fakeConversation>[] = [];
    const r = new PiResponder(async () => {
      const c = fakeConversation(log, { hold: true });
      convs.push(c);
      return c.conversation;
    }, opts(0, 0));
    r.notify(msg("1", "a"), false);
    r.notify(msg("2", "b"), false);
    jest.advanceTimersByTime(1);
    await flush();
    expect(log.slice().sort()).toEqual(["start a", "start b"]); // both open at once
    expect(convs).toHaveLength(2);
    for (const c of convs) c.release();
    await flush();
    r.notify(msg("1", "again"), false);
    jest.advanceTimersByTime(1);
    await flush();
    expect(convs).toHaveLength(2);
    expect(log.at(-1)).toBe("start again");
  });

  it("logs a failed run and drops its batch; the group keeps being served, and a failed creation is retried", async () => {
    const log: string[] = [];
    const rec = recordingLogger();
    let attempts = 0;
    const r = new PiResponder(
      async () => {
        if (++attempts === 1) throw new Error("no key");
        return fakeConversation(log).conversation;
      },
      opts(0, 0, { logger: rec.logger }),
    );
    r.notify(msg("1", "a"), false);
    jest.advanceTimersByTime(1);
    await flush();
    expect(rec.entries.filter((e) => e.level === "error").map((e) => e.msg)).toEqual([expect.stringContaining("no key")]);
    r.notify(msg("1", "b"), false);
    jest.advanceTimersByTime(1);
    await flush();
    expect(log).toEqual(["start b", "end"]); // "a" was dropped, not replayed

    const bad = new PiResponder(async () => fakeConversation(log, { fail: "rate limited" }).conversation, opts(0, 0, { logger: rec.logger }));
    bad.notify(msg("1", "x"), false);
    jest.advanceTimersByTime(1);
    await flush();
    expect(rec.entries.some((e) => e.level === "error" && e.msg.includes("rate limited"))).toBe(true);
    bad.notify(msg("1", "y"), false);
    jest.advanceTimersByTime(1);
    await flush();
    expect(log.filter((l) => l === "start y")).toHaveLength(1);
  });
});
