import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseImageRef } from "../image-store.js";
import type { RunBudget } from "../run-budget.js";
import type { SendFn, SendImageFn } from "../types.js";

export const SEND_TOOL = "send";
export const SEND_IMAGE_TOOL = "send_image";
/** The tools that post in the group; a run that used one of them successfully has "spoken". */
export const SPEAK_TOOLS: readonly string[] = [SEND_TOOL, SEND_IMAGE_TOOL];

const replyToParam = Type.Optional(Type.String({ description: "Id of a message (the id attribute of its <message> element) to quote; omit to post without quoting." }));
const left = (b: RunBudget) => `${b.used}/${b.max} messages used in this run.`;

/**
 * One of the agent's two ways to speak in its group. It can be called several times in a run (each call is one message, posted in
 * call order: the tool is `sequential`), and does not end the run: `stop` does. A failed send is an ordinary tool error, so the agent may retry.
 */
export function createSendTool(send: SendFn, budget: RunBudget) {
  return defineTool({
    name: SEND_TOOL,
    label: "Send message",
    description:
      "Post one message to the group chat. This is the only way anyone in the group sees anything from you; your plain text output is not delivered. " +
      "You may call it several times to post several short messages in order; it does not end the run. Call `stop` when you are done.",
    promptSnippet: "Post a message to the group (call again for more messages; `stop` ends the run)",
    parameters: Type.Object({
      text: Type.String({ description: "The message text." }),
      reply_to: replyToParam,
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, p) => {
      const text = p.text.trim();
      if (!text) throw new Error("Cannot send an empty message.");
      await budget.acquire();
      await send(text, p.reply_to?.trim() || undefined);
      budget.commit();
      return { content: [{ type: "text", text: `Sent. ${left(budget)} Send more, or call stop when you are done.` }], details: { chars: text.length } };
    },
  });
}

/** Posts a picture the group has already seen (by the id from `image_ids` / `search_messages`). */
export function createSendImageTool(sendImage: SendImageFn, budget: RunBudget) {
  return defineTool({
    name: SEND_IMAGE_TOOL,
    label: "Send image",
    description:
      "Post a stored picture to the group chat, optionally with some text in the same message. Pictures are named by their id (like i42): the image_ids attribute of a <message>, or the [图片: …] ids in search_messages results. " +
      "Only pictures that appeared in this group can be sent. It does not end the run.",
    promptSnippet: "Post a stored picture (by id) to the group",
    parameters: Type.Object({
      image_id: Type.String({ description: "The picture's id, e.g. i42." }),
      text: Type.Optional(Type.String({ description: "Text to post together with the picture." })),
      reply_to: replyToParam,
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, p) => {
      const id = parseImageRef(p.image_id);
      if (id === undefined) throw new Error(`"${p.image_id}" is not a picture id (expected something like i42).`);
      await budget.acquire();
      await sendImage(id, p.text?.trim() || undefined, p.reply_to?.trim() || undefined);
      budget.commit();
      return { content: [{ type: "text", text: `Sent picture i${id}. ${left(budget)} Send more, or call stop when you are done.` }], details: { image_id: id } };
    },
  });
}
