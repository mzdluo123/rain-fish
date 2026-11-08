import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Rough cost of one image block (archive frames are ~2.9-3.0k on the major providers). */
export const IMAGE_TOKENS = 3000;
/** Tool schemas ride along with every request but are not in the system prompt text. */
const TOOLS_OVERHEAD_TOKENS = 2500;

const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

/**
 * Cheap token estimate. Latin text averages ~4 chars/token, CJK ~1 token per character,
 * which a plain chars/4 rule underestimates 3-4x for a Chinese-language bot.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

export function estimateMessageTokens(m: AgentMessage): number {
  switch (m.role) {
    case "user":
      return typeof m.content === "string" ? estimateTextTokens(m.content) : blocksTokens(m.content);
    case "toolResult":
      return blocksTokens(m.content);
    case "assistant":
      return m.content.reduce((sum, c) => {
        if (c.type === "text") return sum + estimateTextTokens(c.text);
        if (c.type === "thinking") return sum + estimateTextTokens(c.thinking);
        return sum + estimateTextTokens(c.name) + estimateTextTokens(JSON.stringify(c.arguments));
      }, 4);
    default:
      return 0; // custom message types are not sent to the model by default
  }
}

function blocksTokens(blocks: readonly { type: string; text?: string }[]): number {
  return blocks.reduce((sum, b) => sum + (b.type === "image" ? IMAGE_TOKENS : estimateTextTokens(b.text ?? "")), 0);
}

export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/** What a request would cost: system prompt + tool schemas + messages. */
export function estimateContextTokens(systemPrompt: string, messages: readonly AgentMessage[]): number {
  return estimateTextTokens(systemPrompt) + TOOLS_OVERHEAD_TOKENS + estimateMessagesTokens(messages);
}
