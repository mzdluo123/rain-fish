import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isArchiveMessage } from "./archive.js";
import { estimateMessageTokens, estimateTextTokens } from "./estimate.js";

export interface PruneOptions {
  /** Newest messages worth this many tokens are never touched. */
  recentTokens: number;
  /** Old tool results / tool-call arguments at least this big are cleared. */
  minBlockTokens: number;
  /**
   * Clearing changes the request prefix, so everything after the cleared block misses the provider's prompt cache. Nothing is
   * cleared until this many clearable blocks have fallen out of the recent window; then all of them go at once. Default 1.
   */
  batchBlocks?: number;
}

/** Remembers how far clearing has gone, so a block cleared once stays cleared and the prefix only changes when a batch fires. */
export interface PruneState {
  /** Messages before this index have been cleared. */
  through: number;
}

/**
 * Level 1 of context management: clear the expensive blocks (big tool results, big tool-call
 * arguments such as a whole file passed to `write`) of messages that have fallen out of the
 * recent window. A *view* applied before every model call (nothing is persisted, the stored history stays complete); with a
 * `state` a block never flips back and the output only changes when a batch of blocks is cleared.
 * Message order, tool-call ids and the call/result pairing are preserved - providers require that.
 */
export function pruneExpensive(messages: readonly AgentMessage[], opts: PruneOptions, state: PruneState = { through: 0 }, commit = true): AgentMessage[] {
  // First index of the protected recent tail.
  let boundary = messages.length;
  let acc = 0;
  while (boundary > 0) {
    acc += estimateMessageTokens(messages[boundary - 1]!);
    if (acc > opts.recentTokens) break;
    boundary--;
  }
  let through = Math.min(state.through, messages.length);
  let eligible = 0;
  for (let i = through; i < boundary; i++) if (clearBlocks(messages[i]!, opts.minBlockTokens) !== messages[i]) eligible++;
  if (eligible >= (opts.batchBlocks ?? 1)) through = boundary;
  if (commit) state.through = through; // `commit: false` is for estimates: they must not move the real watermark
  return messages.map((m, i) => (i < through && !isArchiveMessage(m) ? clearBlocks(m, opts.minBlockTokens) : m));
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
