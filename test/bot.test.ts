import { describe, expect, it } from "bun:test";
import { Bot, MAX_REPLY_CHARS, splitReply } from "../src/bot.js";
import { openDb } from "../src/db/open.js";
import { MessageStore } from "../src/store.js";
import { recordingLogger } from "./helpers.js";
import type { GroupMessage, GroupResponder, OutboundSegment, QQApi } from "../src/types.js";

const SELF = "10001";
let n = 0;
const msg = (over: Partial<GroupMessage> = {}): GroupMessage => ({
  platform: "qq", groupId: "100", messageId: String(++n), userId: "42", nickname: "Alice", ts: 1_700_000_000,
  text: "hello", selfId: SELF, isSelf: false, mentionsSelf: false, ...over,
});

function setup(opts: { reply?: string | Error; sendFails?: boolean; groups?: Set<string> } = {}) {
  const store = new MessageStore(openDb(":memory:"));
  const asked: GroupMessage[] = [];
  const sent: { groupId: string; message: OutboundSegment[] }[] = [];
  const rec = recordingLogger();
  const logs = rec.messages;
  const responder: GroupResponder = {
    async respond(m) {
      asked.push(m);
      if (opts.reply instanceof Error) throw opts.reply;
      return opts.reply ?? "你好呀";
    },
  };
  let nextId = 9000;
  const api: QQApi = {
    async sendGroupMessage(groupId, message) {
      if (opts.sendFails) throw new Error("offline");
      sent.push({ groupId, message });
      return { messageId: String(++nextId) };
    },
  };
  const bot = new Bot({ store, responder, api, groups: opts.groups, logger: rec.logger });
  return { bot, store, asked, sent, logs, entries: rec.entries };
}

describe("Bot", () => {
  it("stores every message but only answers when @-mentioned", async () => {
    const { bot, store, asked, sent } = setup();
    await bot.handleGroupMessage(msg({ text: "牛奶 闲聊" }));
    await bot.handleGroupMessage(msg({ text: "牛奶 @bot", mentionsSelf: true }));
    expect(store.search({ query: "牛奶" })).toHaveLength(2);
    expect(asked).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toEqual([
      { type: "reply", data: { id: asked[0]!.messageId } },
      { type: "text", data: { text: "你好呀" } },
    ]);
  });

  it("answers a reply to one of its own messages (sent this run, or stored from message_sent)", async () => {
    const { bot, store, asked } = setup();
    await bot.handleGroupMessage(msg({ mentionsSelf: true })); // bot answers -> sent id 9001
    await bot.handleGroupMessage(msg({ text: "follow up", replyToMessageId: "9001" }));
    expect(asked).toHaveLength(2);

    store.insert({ platform: "qq", groupId: "100", messageId: "555", userId: SELF, nickname: "Yukino", ts: 1, text: "earlier" });
    await bot.handleGroupMessage(msg({ text: "re earlier", replyToMessageId: "555" }));
    expect(asked).toHaveLength(3);

    await bot.handleGroupMessage(msg({ text: "reply to a human", replyToMessageId: "777" }));
    expect(asked).toHaveLength(3);
  });

  it("never answers itself, even when it mentions itself", async () => {
    const { bot, store, asked } = setup();
    await bot.handleGroupMessage(msg({ isSelf: true, mentionsSelf: true, text: "自言自语" }));
    expect(asked).toHaveLength(0);
    expect(store.search({ query: "自言自语" })).toHaveLength(1); // but it is still recorded
  });

  it("ignores groups outside the allowlist entirely", async () => {
    const { bot, store, asked } = setup({ groups: new Set(["100"]) });
    await bot.handleGroupMessage(msg({ groupId: "999", mentionsSelf: true, text: "别的群" }));
    expect(asked).toHaveLength(0);
    expect(store.search({ query: "别的群" })).toHaveLength(0);
  });

  it("stays silent on an empty reply", async () => {
    const { bot, sent } = setup({ reply: "  \n " });
    await bot.handleGroupMessage(msg({ mentionsSelf: true }));
    expect(sent).toHaveLength(0);
  });

  it("splits a long reply: quote only the first chunk, keep order", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `第${i}句话。`).join("");
    const { bot, sent } = setup({ reply: long });
    await bot.handleGroupMessage(msg({ mentionsSelf: true }));
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0]!.message[0]!.type).toBe("reply");
    expect(sent.slice(1).every((s) => s.message.length === 1 && s.message[0]!.type === "text")).toBe(true);
    const texts = sent.map((s) => s.message.find((m) => m.type === "text")!.data as { text: string }).map((d) => d.text);
    expect(texts.every((t) => t.length <= MAX_REPLY_CHARS)).toBe(true);
    expect(texts.join("")).toBe(long);
  });

  it("contains responder and send failures: logs, does not throw", async () => {
    const a = setup({ reply: new Error("LLM down") });
    await a.bot.handleGroupMessage(msg({ mentionsSelf: true }));
    expect(a.entries).toContainEqual({ level: "error", msg: expect.stringContaining("LLM down") });
    const b = setup({ sendFails: true });
    await b.bot.handleGroupMessage(msg({ mentionsSelf: true }));
    expect(b.entries).toContainEqual({ level: "error", msg: expect.stringContaining("offline") });
  });
});

describe("splitReply", () => {
  it("returns short text as one chunk and never loses characters", () => {
    expect(splitReply("short")).toEqual(["short"]);
    expect(splitReply("")).toEqual([]);
    const s = "a".repeat(3200);
    expect(splitReply(s).join("")).toBe(s);
    expect(splitReply(s).every((c) => c.length <= MAX_REPLY_CHARS)).toBe(true);
  });
});
