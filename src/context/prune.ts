import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { isArchiveMessage } from "./archive.js";
import { estimateMessageTokens, estimateTextTokens } from "./estimate.js";

export interface PruneOptions {
  /** Newest messages worth this many tokens are never touched. */
  recentTokens: number;
  /** Old tool results / tool-call arguments at least this big are cleared. */
  minBlockTokens: number;
}

/**
 * Level 1 of context management: clear the expensive blocks (big tool results, big tool-call
 * arguments such as a whole file passed to `write`) of messages that have fallen out of the
 * recent window. Pure and deterministic, so it can be applied to a *view* before every model call
 * (nothing is persisted, the stored history stays complete) and a block never flips back.
 * Message order, tool-call ids and the call/result pairing are preserved - providers require that.
 */
export function pruneExpensive(messages: readonly AgentMessage[], opts: PruneOptions): AgentMessage[] {
  // First index of the protected recent tail.
  let boundary = messages.length;
  let acc = 0;
  while (boundary > 0) {
    acc += estimateMessageTokens(messages[boundary - 1]!);
    if (acc > opts.recentTokens) break;
    boundary--;
  }
  return messages.map((m, i) => (i < boundary && !isArchiveMessage(m) ? clearBlocks(m, opts.minBlockTokens) : m));
}

function clearBlocks(m: AgentMessage, min: number): AgentMessage {
  if (m.role === "toolResult") {
    const tokens = estimateMessageTokens(m);
    if (tokens < min) return m;
    return { ...m, content: [{ type: "text", text: `[已清理：${m.toolName} 的输出，约 ${tokens} tokens]` }] };
  }
  if (m.role === "assistant" && m.content.some((c) => c.type === "toolCall")) {
    let changed = false;
    const content = m.content.map((c) => {
      if (c.type !== "toolCall") return c;
      const args = Object.fromEntries(
        Object.entries(c.arguments).map(([k, v]) => {
          if (typeof v !== "string" || estimateTextTokens(v) < min) return [k, v];
          changed = true;
          return [k, `[已清理：${v.length} 字符]`];
        }),
      );
      return { ...c, arguments: args };
    });
    return changed ? { ...m, content } : m;
  }
  return m;
}
