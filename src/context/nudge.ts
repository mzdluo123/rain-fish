import { escapeText, systemMessage } from "../xml.js";

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

const LISTED_MAX = 20;

function listUnlinked(paths: readonly string[]): string {
  const shown = paths.slice(0, LISTED_MAX).map((p) => `- ${escapeText(p)}`);
  if (paths.length > LISTED_MAX) shown.push(`- …另有 ${paths.length - LISTED_MAX} 个`);
  return shown.join("\n");
}

const LINK_RULE = "规则：每个 .md 文件都要能从 `/persona.md` 出发，沿 Markdown 链接（如 `[主题](/notes/topic.md)`，用以 `/` 开头的绝对路径）一层层找到。";

/** Appended to every batch while `/persona.md` does not reach every `.md` file (the check runs at the start of every run). */
export const linkNotice = (paths: readonly string[]): string =>
  systemMessage([`档案检查：下面的 .md 文件还没有被 \`/persona.md\` 的树链接到。`, LINK_RULE, listUnlinked(paths), "这一轮请先用 `edit` 在合适的父文件里加上指向它们的链接，再做其他事。"].join("\n"));

/** The single reminder turn after a run that created or wrote files and left some `.md` file outside the tree. */
export const linkNudgePrompt = (paths: readonly string[]): string =>
  systemMessage(["提醒：这不是群里的消息。", "你刚才创建或写入了文件，档案检查发现下面的 .md 文件没有被 `/persona.md` 的树链接到。", LINK_RULE, listUnlinked(paths), "现在就用 `edit` 在合适的父文件里加上指向它们的链接，完成后调用 `stop`。"].join("\n"));
