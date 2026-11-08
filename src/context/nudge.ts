import { systemMessage } from "../xml.js";

/**
 * Protocol framing (not persona) for the single retry turn after a run in which someone addressed the agent but it never
 * called `send`: plain model text is never delivered, so without this the person would simply get no answer.
 */
export const SEND_NUDGE_PROMPT = systemMessage(
  [
    "提醒：这不是群里的消息。",
    "刚才有人 @ 了你或回复了你，但你上一轮没有调用 `send`，所以群里没有任何人看到你写的文字。",
    "- 如果你想回应对方：现在就调用 `send`，把要说的话合并成一条（可用 `reply_to` 引用对方的消息 id）。",
    "- 如果你确实决定不回应：直接结束这一轮，不要再写文字。",
  ].join("\n"),
);
