import { describe, expect, it } from "bun:test";
import { Bot, MAX_REPLY_CHARS, splitReply } from "../src/bot.js";
import { openDb } from "../src/db/open.js";
import { MessageStore } from "../src/store.js";
import { ImageStore } from "../src/image-store.js";
import { memoryEventLog, recordingLogger } from "./helpers.js";
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
  const trace = memoryEventLog();
  const bot = new Bot({ store, responder, api, groups: opts.groups, logger: rec.logger, events: trace.events });
  return { bot, store, notified, sent, trace };
}

describe("Bot ingestion", () => {
  it("stores every message and queues every non-self message, flagging the ones addressed to the bot", () => {
    const { bot, store, notified } = setup();
    bot.handleGroupMessage(msg({ text: "牛奶 闲聊" }));
    bot.handleGroupMessage(msg({ text: "牛奶 @bot", mentionsSelf: true }));
    expect(store.search({ query: "牛奶" })).toHaveLength(2);
    expect(notified.map((n) => n.addressed)).toEqual([false, true]);
  });

  it("treats a reply to one of its own messages as addressed: sent messages are stored, so this survives a restart; message_sent echoes work too", async () => {
    const first = setup();
    first.bot.handleGroupMessage(msg({ text: "hello" })); // teaches the bot its own id
    await first.bot.sendText("100", "hi"); // sent id 9001
    expect(first.store.get("qq", "100", "9001")).toMatchObject({ userId: SELF, text: "hi" });
    first.bot.handleGroupMessage(msg({ text: "follow up", replyToMessageId: "9001" }));
    expect(first.notified.at(-1)!.addressed).toBe(true);

    // "restart": a new Bot (no memory) on the same database still recognises it
    const restarted = new Bot({ store: first.store, responder: { notify: (m, a) => first.notified.push({ msg: m, addressed: a }) }, api: { sendGroupMessage: async () => ({ messageId: "1" }) } });
    restarted.handleGroupMessage(msg({ text: "late reply", replyToMessageId: "9001" }));
    expect(first.notified.at(-1)!.addressed).toBe(true);

    first.store.insert({ platform: "qq", groupId: "100", messageId: "555", userId: SELF, nickname: "Yukino", ts: 1, text: "earlier" });
    first.bot.handleGroupMessage(msg({ text: "re earlier", replyToMessageId: "555" }));
    first.bot.handleGroupMessage(msg({ text: "reply to a human", replyToMessageId: "777" }));
    expect(first.notified.slice(-2).map((n) => n.addressed)).toEqual([true, false]);
  });

  it("noteSelfId (from the lifecycle event) lets a first send be stored before any group message arrived", async () => {
    const { bot, store } = setup();
    bot.noteSelfId(SELF);
    await bot.sendText("100", "hi");
    expect(store.get("qq", "100", "9001")?.userId).toBe(SELF);
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

describe("Bot event log", () => {
  it("records every incoming message with its flags, but no text unless content capture is on", () => {
    const { bot, trace } = setup();
    bot.handleGroupMessage(msg({ text: "牛奶 @bot", mentionsSelf: true, replyToMessageId: "5" }));
    bot.handleGroupMessage(msg({ isSelf: true, text: "自言自语" }));
    const [a, b] = trace.records("msg.in");
    expect(a).toMatchObject({ group: "100", user_id: "42", chars: 7, addressed: true, mention: true, reply_to: "5", queued: true, self: false });
    expect("text" in a!).toBe(false);
    expect(b).toMatchObject({ self: true, queued: false });
  });

  it("records duplicates and sends (per chunk, with the quoted id only on the first)", async () => {
    const { bot, trace } = setup();
    const m = msg({ text: "dup" });
    bot.handleGroupMessage(m);
    bot.handleGroupMessage(m);
    expect(trace.names("msg.in", "msg.duplicate")).toEqual(["msg.in", "msg.duplicate"]);

    const long = Array.from({ length: 400 }, (_, i) => `第${i}句话。`).join("");
    await bot.sendText("100", long, "42");
    const outs = trace.records("msg.out");
    expect(outs.length).toBeGreaterThan(1);
    expect(outs.map((o) => o.chunk)).toEqual(outs.map((_, i) => i));
    expect(outs[0]).toMatchObject({ chunks: outs.length, reply_to: "42" });
    expect(outs[1]!.reply_to).toBeUndefined();
  });

  it("records a failed send", async () => {
    const { bot, trace } = setup({ sendFails: true });
    await expect(bot.sendText("100", "hi")).rejects.toThrow();
    expect(trace.records("msg.out_failed")[0]).toMatchObject({ group: "100", chunk: 0, chunks: 1, error: { message: "offline" } });
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

describe("Bot pictures", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  function withImages() {
    const s = setup();
    const db = openDb(":memory:");
    const images = new ImageStore(db);
    const captured: GroupMessage[] = [];
    const bot = new Bot({ store: new MessageStore(db), images, pictures: { capture: async (m) => (captured.push(m), []), image: async () => undefined }, responder: { notify() {} }, api: { sendGroupMessage: async (groupId, message) => (s.sent.push({ groupId, message }), { messageId: "9001" }) }, events: s.trace.events });
    bot.noteSelfId(SELF);
    return { ...s, bot, images, captured, store: new MessageStore(db), db };
  }

  it("captures the pictures of incoming messages in the background, but not text-only or own messages", () => {
    const { bot, captured } = withImages();
    bot.handleGroupMessage(msg({ images: [{ url: "https://p.qpic.cn/a" }] }));
    bot.handleGroupMessage(msg({ text: "plain" }));
    bot.handleGroupMessage(msg({ isSelf: true, images: [{ url: "https://p.qpic.cn/b" }] }));
    expect(captured).toHaveLength(1);
  });

  it("sendImage posts the stored picture as base64 with reply and text, and stores the sent message linked to the picture", async () => {
    const { bot, images, sent, db } = withImages();
    const id = images.put("100", "m1", 0, png, "image/png");
    await bot.sendImage("100", id, " 给你 ", "55");
    expect(sent[0]!.message).toEqual([
      { type: "reply", data: { id: "55" } },
      { type: "image", data: { file: `base64://${png.toString("base64")}` } },
      { type: "text", data: { text: "给你" } },
    ]);
    const row = new MessageStore(db).get("qq", "100", "9001");
    expect(row?.text).toBe("[图片]给你");
    expect(images.idsOf("100", "9001")).toEqual([id]);
  });

  it("sendImage refuses a picture this group never saw, without calling the API", async () => {
    const { bot, images, sent } = withImages();
    const id = images.put("200", "m1", 0, png, "image/png");
    await expect(bot.sendImage("100", id)).rejects.toThrow(/No picture/);
    await expect(bot.sendImage("100", 999)).rejects.toThrow(/No picture/);
    expect(sent).toHaveLength(0);
  });
});

describe("Bot replies to synthetic ids", () => {
  it("sendText omits the reply segment for a non-numeric id (poke) and still sends", async () => {
    const { bot, sent } = setup();
    await bot.sendText("100", "hi", "poke-1700000000-42");
    expect(sent[0]!.message).toEqual([{ type: "text", data: { text: "hi" } }]);
    await bot.sendText("100", "yo", "-55");
    expect(sent[1]!.message[0]).toEqual({ type: "reply", data: { id: "-55" } });
  });

  it("sendImage omits the reply segment for a non-numeric id and still sends", async () => {
    const store = new MessageStore(openDb(":memory:"));
    const db = openDb(":memory:");
    const images = new ImageStore(db);
    const sent: OutboundSegment[][] = [];
    const bot = new Bot({ store, images, responder: { notify() {} }, api: { sendGroupMessage: async (_g, m) => (sent.push(m), { messageId: "1" }) } });
    const id = images.put("100", "m1", 0, Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
    await bot.sendImage("100", id, undefined, "poke-1-2");
    expect(sent[0]!.some((s) => s.type === "reply")).toBe(false);
  });
});
