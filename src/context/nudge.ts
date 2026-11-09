import { escapeText, systemMessage } from "../xml.js";

/**
 * Protocol framing (not persona) for the single retry turn after a run in which someone addressed the agent but it never
 * called `send`: plain model text is never delivered, so without this the person would simply get no answer.
 */
export const SEND_NUDGE_PROMPT = systemMessage(
  [
    "Reminder: this is not a group message.",
    "Someone @-mentioned or replied to you, but your last turn did not call `send`, so nobody in the group saw your text.",
    "- To respond: call `send` now (`reply_to` quotes their message id), then `stop`.",
    "- If you really decided not to respond: call `stop` and write no more text.",
  ].join("\n"),
);

/** Appended to a batch every few runs: the agent must join the conversation instead of only watching. */
export const SPEAK_NOTICE = systemMessage("You must say something to join the conversation: this run, call `send` (or `send_image`) with a message that fits the current topic, then `stop`. Do not stay silent.");

/** The single retry turn when a run that carried `SPEAK_NOTICE` ended without a successful `send`. */
export const SPEAK_NUDGE_PROMPT = systemMessage(
  ["Reminder: this is not a group message.", "You were required to say something, but your last turn did not successfully call `send`, so nobody saw it. Call `send` now with a message that fits the current topic, then `stop`."].join("\n"),
);

const LISTED_MAX = 20;

function listUnlinked(paths: readonly string[]): string {
  const shown = paths.slice(0, LISTED_MAX).map((p) => `- ${escapeText(p)}`);
  if (paths.length > LISTED_MAX) shown.push(`- …and ${paths.length - LISTED_MAX} more`);
  return shown.join("\n");
}

const LINK_RULE = "Rule: every .md and .py file must be reachable from `/persona.md` by Markdown links with absolute paths (e.g. `[topic](/notes/topic.md)`, `[script](/scripts/calc.py)`).";

/** Appended to every batch while `/persona.md` does not reach every `.md`/`.py` file (the check runs at the start of every run). */
export const linkNotice = (paths: readonly string[]): string =>
  systemMessage(["Notes check: the files below are not linked from the `/persona.md` tree.", LINK_RULE, listUnlinked(paths), "This run, first use `edit` to add links to them in a suitable parent file, then do the rest."].join("\n"));

/** The single reminder turn after a run that created or wrote files and left some `.md`/`.py` file outside the tree. */
export const linkNudgePrompt = (paths: readonly string[]): string =>
  systemMessage(["Reminder: this is not a group message.", "You just created or wrote files; the notes check found the files below are not linked from the `/persona.md` tree.", LINK_RULE, listUnlinked(paths), "Use `edit` now to add links to them in a suitable parent file, then call `stop`."].join("\n"));
