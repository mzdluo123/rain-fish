import { systemMessage } from "../xml.js";

/**
 * Protocol framing (not persona) for the extra turn that runs just before older history is compacted:
 * the agent saves what it wants to keep into its Markdown files while it still sees the full text.
 */
export const MEMORY_FLUSH_PROMPT = systemMessage(
  [
    "整理记忆：这不是群里的消息。",
    "对话上下文快满了，较早的对话马上会被压缩成存档，细节会丢失。请现在回顾这段对话，把你觉得重要、以后还用得上的内容写进你的文件系统：",
    "群友的喜好和约定、群里的梗、答应过别人的事、你自己设定的变化、值得留存的结论等；只出现一次的琐事和任何人的隐私不要记，消息可以被找回，不用记忆。",
    "- 优先用 `edit` 补充已有的文件，没有合适的再新建；先用 `read`/`ls` 看看现有的记忆是什么样，避免重复。",
    "- 文件只能是 .md，单个文件不超过 10KB。放不下时新建文件，把内容原样挪过去（不要压缩、概括或丢信息），并用 Markdown 链接把它们串起来，",
    "  让整套记忆按语义组织成一棵树：入口文件 `/persona.md` 链接到各主题文件，主题文件还可以再链接更细的文件。",
    "- 本轮不能发消息，也不用回复。整理完直接结束；没什么需要记的，直接结束即可。",
  ].join("\n"),
);
