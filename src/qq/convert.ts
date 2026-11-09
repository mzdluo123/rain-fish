import type { GroupMessage, GroupMessageEvent, PokeEvent, Segment } from "../types.js";

function segmentText(seg: Segment): string {
  switch (seg.type) {
    case "text":
      return seg.data.text;
    case "at":
      return seg.data.qq === "all" ? "@全体成员" : `@${seg.data.name ?? seg.data.qq}`;
    case "reply":
      return "";
    case "face":
    case "mface":
      return "[表情]";
    case "image":
      return "[图片]";
    case "record":
      return "[语音]";
    case "video":
      return "[视频]";
    case "file":
      return "[文件]";
    case "json":
      return "[卡片]";
    case "forward":
      return "[聊天记录]";
    case "dice":
      return "[骰子]";
    case "rps":
      return "[猜拳]";
    case "poke":
      return "[戳一戳]";
    case "unknown":
      return `[${seg.original}]`;
  }
}

/** Validated wire event -> the flat message the core works with. Returns null if there is nothing to say. */
export function toGroupMessage(e: GroupMessageEvent): GroupMessage | null {
  const text = e.message.map(segmentText).join("").trim();
  if (!text) return null;
  const nickname = e.sender?.card?.trim() || e.sender?.nickname?.trim() || e.user_id;
  const reply = e.message.find((s) => s.type === "reply");
  // Photos, stickers (image sub_type 1) and market stickers (mface) are all sent to the model.
  const images = e.message.flatMap((s) => ((s.type === "image" || s.type === "mface") && "url" in s.data && typeof s.data.url === "string" ? [{ url: s.data.url }] : []));
  return {
    platform: "qq",
    groupId: e.group_id,
    messageId: e.message_id,
    userId: e.user_id,
    nickname,
    ts: e.time,
    text,
    selfId: e.self_id,
    isSelf: e.post_type === "message_sent" || e.user_id === e.self_id,
    mentionsSelf: e.message.some((s) => s.type === "at" && s.data.qq === e.self_id),
    replyToMessageId: reply?.type === "reply" ? reply.data.id : undefined,
    ...(images.length > 0 ? { images } : {}),
  };
}

/**
 * A poke aimed at the bot -> a message from the poker that addresses the bot, so it is stored and answered like any other.
 * The notice carries no nickname, so the poker is named by QQ number. Pokes at someone else, and the bot's own pokes, give null.
 * The id is synthetic (poke + second + poker): a redelivered notice is a duplicate, as with real messages.
 */
export function toPokeMessage(e: PokeEvent): GroupMessage | null {
  if (e.user_id === e.self_id) return null;
  if (e.target_id != null && e.target_id !== e.self_id) return null;
  return {
    platform: "qq",
    groupId: e.group_id,
    messageId: `poke-${e.time}-${e.user_id}`,
    userId: e.user_id,
    nickname: e.user_id,
    ts: e.time,
    text: "[戳一戳] 戳了你一下",
    selfId: e.self_id,
    isSelf: false,
    mentionsSelf: true,
  };
}
