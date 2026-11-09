import { describe, expect, it } from "bun:test";
import { toGroupMessage, toPokeMessage } from "../src/qq/convert.js";
import { parseFrame } from "../src/qq/frame.js";
import type { GroupMessage } from "../src/types.js";

const convert = (over: Record<string, unknown>): GroupMessage | null => {
  const f = parseFrame(
    JSON.stringify({ post_type: "message", message_type: "group", message_id: 1, group_id: 100, user_id: 42, self_id: 10001, time: 1_700_000_000, sender: { nickname: "Alice", card: "" }, ...over }),
  );
  if (f.kind !== "group_message") throw new Error(`not a group message: ${f.kind}`);
  return toGroupMessage(f.event);
};
const text = (t: string) => ({ type: "text", data: { text: t } });

describe("toGroupMessage", () => {
  it("keeps the url of photos, stickers and market stickers, but not of url-less ones", () => {
    const m = convert({
      message: [
        { type: "image", data: { url: "https://multimedia.nt.qq.com.cn/a", sub_type: 0, file: "x.jpg" } },
        { type: "image", data: { url: "https://multimedia.nt.qq.com.cn/s", sub_type: 1 } },
        { type: "mface", data: { url: "https://gxh.vip.qq.com/m.gif", emoji_id: "1", summary: "[x]" } },
        { type: "image", data: {} },
        { type: "mface", data: { emoji_id: "2" } },
        { type: "face", data: { id: "1" } },
      ],
    });
    expect(m?.images).toEqual([{ url: "https://multimedia.nt.qq.com.cn/a" }, { url: "https://multimedia.nt.qq.com.cn/s" }, { url: "https://gxh.vip.qq.com/m.gif" }]);
    expect(m?.text).toBe("[图片][图片][表情][图片][表情][表情]"); // every picture stays visible as text
    expect(convert({ message: [text("no pictures")] })).not.toHaveProperty("images");
  });

  it("flattens segments to searchable text", () => {
    const m = convert({
      message: [
        { type: "reply", data: { id: "77" } },
        { type: "at", data: { qq: "7", name: "Yukino" } },
        text(" 今天喝牛奶 "),
        { type: "image", data: {} },
        { type: "face", data: { id: "1" } },
        { type: "at", data: { qq: "all" } },
        { type: "weird", data: {} },
      ],
    });
    expect(m?.text).toBe("@Yukino 今天喝牛奶 [图片][表情]@全体成员[weird]");
    expect(m).toMatchObject({ platform: "qq", groupId: "100", messageId: "1", userId: "42", nickname: "Alice", ts: 1_700_000_000, selfId: "10001", replyToMessageId: "77" });
  });

  it("detects a mention of the bot, but not @all or other users", () => {
    expect(convert({ message: [{ type: "at", data: { qq: 10001 } }, text("hi")] })?.mentionsSelf).toBe(true);
    expect(convert({ message: [{ type: "at", data: { qq: "all" } }, text("hi")] })?.mentionsSelf).toBe(false);
    expect(convert({ message: [{ type: "at", data: { qq: 5 } }, text("hi")] })?.mentionsSelf).toBe(false);
  });

  it("marks the bot's own messages", () => {
    expect(convert({ post_type: "message_sent", user_id: 10001, message: [text("x")] })?.isSelf).toBe(true);
    expect(convert({ user_id: 10001, message: [text("x")] })?.isSelf).toBe(true);
    expect(convert({ message: [text("x")] })?.isSelf).toBe(false);
  });

  it("prefers the group card, then nickname, then the user id", () => {
    expect(convert({ sender: { nickname: "Alice", card: "群名片" }, message: [text("x")] })?.nickname).toBe("群名片");
    expect(convert({ sender: { nickname: "Alice" }, message: [text("x")] })?.nickname).toBe("Alice");
    expect(convert({ sender: undefined, message: [text("x")] })?.nickname).toBe("42");
  });

  it("returns null when there is no text at all", () => {
    expect(convert({ message: [{ type: "reply", data: { id: "1" } }] })).toBeNull();
    expect(convert({ message: [text("   ")] })).toBeNull();
  });
});

describe("group pokes", () => {
  const poke = (over: Record<string, unknown>) =>
    parseFrame(JSON.stringify({ post_type: "notice", notice_type: "notify", sub_type: "poke", self_id: 10001, time: 1_700_000_000, group_id: 100, user_id: 42, target_id: 10001, ...over }));
  const msg = (over: Record<string, unknown>) => {
    const f = poke(over);
    if (f.kind !== "group_poke") throw new Error(`not a poke: ${f.kind}`);
    return toPokeMessage(f.event);
  };

  it("a poke at the bot becomes an addressed message from the poker, with a stable id", () => {
    const m = msg({});
    expect(m).toMatchObject({ groupId: "100", userId: "42", selfId: "10001", mentionsSelf: true, isSelf: false, text: "[戳一戳] 戳了你一下" });
    expect(m?.messageId).toBe(msg({})?.messageId);
    expect(m?.messageId).not.toBe(msg({ user_id: 43 })?.messageId);
  });

  it("target_id missing or null (some OneBot implementations) still means the bot", () => {
    expect(msg({ target_id: undefined })).not.toBeNull();
    expect(msg({ target_id: null })).not.toBeNull();
  });

  it("pokes at someone else and the bot's own pokes give nothing; private pokes are ignored by the parser", () => {
    expect(msg({ target_id: 77 })).toBeNull();
    expect(msg({ user_id: 10001, target_id: 77 })).toBeNull();
    expect(msg({ user_id: 10001 })).toBeNull();
    expect(poke({ group_id: undefined }).kind).toBe("ignored");
  });
});
