import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TRANSFER_MAX_FILE_BYTES } from "../colab/files.js";
import { parseImageRef } from "../image-store.js";
import { sniffImageMime } from "../images.js";
import { VirtualFs } from "../vfs.js";
import type { RunBudget } from "../run-budget.js";
import type { ImageSendSource, SendFn, SendImageFn } from "../types.js";

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

/** Posts a group-scoped stored picture or a generated VFS artifact. */
export function createSendImageTool(sendImage: SendImageFn, budget: RunBudget, fs: VirtualFs) {
  return defineTool({
    name: SEND_IMAGE_TOOL,
    label: "Send image",
    description:
      "Post a stored picture to the group chat, optionally with some text in the same message. Pictures are named by their id (like i42): the image_ids attribute of a <message>, or the [图片: …] ids in search_messages results. " +
      "Use exactly one of image_id (a picture this group has seen) or artifact_path (an absolute VFS path under /artifacts/). Artifacts must be JPEG, PNG, GIF or WebP, at most 1 MiB; host paths and URLs are never read. It does not end the run.",
    promptSnippet: "Post a picture by image_id or VFS artifact_path to the group",
    parameters: Type.Object({
      image_id: Type.Optional(Type.String({ description: "The picture's id, e.g. i42; omit when using artifact_path." })),
      artifact_path: Type.Optional(Type.String({ description: "Absolute VFS path of a generated image, e.g. /artifacts/plot.png; omit when using image_id." })),
      text: Type.Optional(Type.String({ description: "Text to post together with the picture." })),
      reply_to: replyToParam,
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, p) => {
      if ((p.image_id !== undefined) === (p.artifact_path !== undefined)) throw new Error("Provide exactly one of image_id or artifact_path.");
      let source: ImageSendSource;
      let label: string;
      if (p.artifact_path !== undefined) {
        const file = VirtualFs.normalize(p.artifact_path);
        if (!p.artifact_path.startsWith("/") || !file.startsWith("/artifacts/")) throw new Error("artifact_path must be an absolute VFS path under /artifacts/.");
        const st = fs.stat(file);
        if (st && st.size > TRANSFER_MAX_FILE_BYTES) throw new Error("Artifact image exceeds the 1 MiB limit.");
        const data = fs.readFile(file);
        const mime = sniffImageMime(data);
        if (!mime) throw new Error("Artifact must be a JPEG, PNG, GIF or WebP image.");
        source = { data, mime };
        label = file;
      } else {
        const id = parseImageRef(p.image_id!);
        if (id === undefined) throw new Error(`"${p.image_id}" is not a picture id (expected something like i42).`);
        source = id;
        label = `i${id}`;
      }
      await budget.acquire();
      await sendImage(source, p.text?.trim() || undefined, p.reply_to?.trim() || undefined);
      budget.commit();
      return { content: [{ type: "text", text: `Sent picture. ${left(budget)} Send more, or call stop when you are done.` }], details: typeof source === "number" ? { image_id: source } : { artifact_path: label } };
    },
  });
}
