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

function setup(opts: { sendFails?: boolean; groups?: Set<string> } = {}) {
  const store = new MessageStore(openDb(":memory:"));
  const notified: { msg: GroupMessage; addressed: boolean }[] = [];
  const sent: { groupId: string; message: OutboundSegment[] }[] = [];
  const rec = recordingLogger();
  const responder: GroupResponder = {
    notify(msg, addressed) {
      notified.push({ msg, addressed });
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
  return { bot, store, notified, sent };
}

describe("Bot ingestion", () => {
  it("stores every message and queues every non-self message, flagging the ones addressed to the bot", () => {
    const { bot, store, notified } = setup();
    bot.handleGroupMessage(msg({ text: "牛奶 闲聊" }));
    bot.handleGroupMessage(msg({ text: "牛奶 @bot", mentionsSelf: true }));
    expect(store.search({ query: "牛奶" })).toHaveLength(2);
    expect(notified.map((n) => n.addressed)).toEqual([false, true]);
  });

  it("treats a reply to one of its own messages as addressed (sent this run, or stored from message_sent)", async () => {
    const { bot, store, notified } = setup();
    await bot.sendText("100", "hi"); // sent id 9001
    bot.handleGroupMessage(msg({ text: "follow up", replyToMessageId: "9001" }));
    store.insert({ platform: "qq", groupId: "100", messageId: "555", userId: SELF, nickname: "Yukino", ts: 1, text: "earlier" });
    bot.handleGroupMessage(msg({ text: "re earlier", replyToMessageId: "555" }));
    bot.handleGroupMessage(msg({ text: "reply to a human", replyToMessageId: "777" }));
    expect(notified.map((n) => n.addressed)).toEqual([true, true, false]);
  });

  it("records but never queues its own messages", () => {
    const { bot, store, notified } = setup();
    bot.handleGroupMessage(msg({ isSelf: true, mentionsSelf: true, text: "自言自语" }));
    expect(notified).toHaveLength(0);
    expect(store.search({ query: "自言自语" })).toHaveLength(1);
  });

  it("ignores groups outside the allowlist entirely", () => {
    const { bot, store, notified } = setup({ groups: new Set(["100"]) });
    bot.handleGroupMessage(msg({ groupId: "999", mentionsSelf: true, text: "别的群" }));
    expect(notified).toHaveLength(0);
    expect(store.search({ query: "别的群" })).toHaveLength(0);
  });
});

describe("Bot.sendText", () => {
  it("quotes only when asked, and only the first chunk", async () => {
    const { bot, sent } = setup();
    await bot.sendText("100", "plain");
    expect(sent[0]!.message).toEqual([{ type: "text", data: { text: "plain" } }]);

    const long = Array.from({ length: 400 }, (_, i) => `第${i}句话。`).join("");
    sent.length = 0;
    await bot.sendText("100", long, "42");
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0]!.message[0]).toEqual({ type: "reply", data: { id: "42" } });
    expect(sent.slice(1).every((s) => s.message.length === 1 && s.message[0]!.type === "text")).toBe(true);
    const texts = sent.map((s) => s.message.find((m) => m.type === "text")!.data as { text: string }).map((d) => d.text);
    expect(texts.every((t) => t.length <= MAX_REPLY_CHARS)).toBe(true);
    expect(texts.join("")).toBe(long);
  });

  it("rejects when delivery fails, so the agent's send tool can report it", async () => {
    const { bot } = setup({ sendFails: true });
    await expect(bot.sendText("100", "hi")).rejects.toThrow(/offline/);
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
