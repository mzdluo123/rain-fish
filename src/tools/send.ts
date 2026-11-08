import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { SendFn } from "../types.js";

export const SEND_TOOL = "send";

/**
 * The agent's only way to speak in its group. A successful send ends the run (`terminate`): nothing
 * more happens until the next wake-up. A failed send is an ordinary tool error, so the agent may retry.
 */
export function createSendTool(send: SendFn) {
  return defineTool({
    name: SEND_TOOL,
    label: "Send message",
    description:
      "Post a message to the group chat. This is the only way anyone in the group sees anything from you; your plain text output is not delivered. " +
      "Sending ends this run: you are not called again until the next wake-up, so put everything you want to say into one message.",
    promptSnippet: "Post a message to the group (ends the run)",
    parameters: Type.Object({
      text: Type.String({ description: "The message text." }),
      reply_to: Type.Optional(Type.String({ description: "Id of a message (the id attribute of its <message> element) to quote; omit to post without quoting." })),
    }),
    execute: async (_toolCallId, p) => {
      const text = p.text.trim();
      if (!text) throw new Error("Cannot send an empty message.");
      await send(text, p.reply_to?.trim() || undefined);
      return { content: [{ type: "text", text: "Sent. The run ends here; you will be woken up again later." }], details: { chars: text.length }, terminate: true };
    },
  });
}
