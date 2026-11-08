import { systemMessage } from "../xml.js";

/**
 * Protocol framing (not persona) for the single retry turn after a run in which someone addressed the agent but it never
 * called `send`: plain model text is never delivered, so without this the person would simply get no answer.
 */
export const SEND_NUDGE_PROMPT = systemMessage(
  [
    "提醒：这不是群里的消息。",
    "刚才有人 @ 了你或回复了你，但你上一轮没有调用 `send`，所以群里没有任何人看到你写的文字。",
    "- 如果你想回应对方：现在就调用 `send`（可用 `reply_to` 引用对方的消息 id），说完调用 `stop`。",
    "- 如果你确实决定不回应：调用 `stop`，不要再写文字。",
  ].join("\n"),
);

/** Appended to a batch every few runs: the agent must join the conversation instead of only watching. */
export const SPEAK_NOTICE = systemMessage("你必须要说点什么来插入群友的聊天：这一轮请调用 `send` 发消息（或 `send_image` 发图）接上当前话题，说完调用 `stop`，不要沉默。");

/** The single retry turn when a run that carried `SPEAK_NOTICE` ended without a successful `send`. */
export const SPEAK_NUDGE_PROMPT = systemMessage(
  ["提醒：这不是群里的消息。", "上一轮要求你必须说点什么来插入群友的聊天，但你没有成功调用 `send`，群里没有任何人看到你的话。现在就调用 `send` 发一条贴合当前话题的消息，然后调用 `stop`。"].join("\n"),
);
