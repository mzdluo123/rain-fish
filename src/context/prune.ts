import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isArchiveMessage } from "./archive.js";
import { imageKey } from "./image-key.js";
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
  // Pictures of the turn in progress are never cleared: the model may need to look at them again after a tool call.
  const lastUser = messages.findLastIndex((m) => m.role === "user" && !isArchiveMessage(m));
  let through = Math.min(state.through, messages.length);
  let eligible = 0;
  for (let i = through; i < boundary; i++) if (clearBlocks(messages[i]!, opts.minBlockTokens, i < lastUser) !== messages[i]) eligible++;
  if (eligible >= (opts.batchBlocks ?? 1)) through = boundary;
  if (commit) state.through = through; // `commit: false` is for estimates: they must not move the real watermark
  return dedupeImages(messages.map((m, i) => (i < through ? clearBlocks(m, opts.minBlockTokens, i < lastUser) : m)));
}

/**
 * The same picture sent more than once is shown once, at its newest occurrence (older copies become a placeholder), so
 * it is billed once. Part of the view, deterministic: only changes when a new copy arrives. Archive frames are exempt.
 */
function dedupeImages(messages: AgentMessage[]): AgentMessage[] {
  const seen = new Set<string>();
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "user" || !Array.isArray(m.content) || isArchiveMessage(m) || !m.content.some((c) => c.type === "image")) continue;
    let changed = false;
    const content = m.content.map((c) => {
      if (c.type !== "image") return c;
      const key = imageKey(c);
      if (!seen.has(key)) return seen.add(key), c;
      changed = true;
      return { type: "text" as const, text: "[重复图片：同一张图见后文]" };
    });
    if (changed) out[i] = { ...m, content };
  }
  return out;
}

function clearBlocks(m: AgentMessage, min: number, clearImages: boolean): AgentMessage {
  if (isArchiveMessage(m)) return m; // its frames are the compacted history: never cleared
  if (clearImages && m.role === "user" && Array.isArray(m.content) && m.content.some((c) => c.type === "image")) {
    // A picture is billed every request (~3k tokens). Once it is out of the recent window the model keeps the sender's text only.
    return { ...m, content: m.content.map((c) => (c.type === "image" ? { type: "text" as const, text: "[已清理：图片]" } : c)) };
  }
  if (clearImages && m.role === "toolResult" && m.content.some((c) => c.type === "image")) {
    // `view_image` results: the same ~3k tokens per request as a chat picture, cleared the same way once its turn is over.
    return { ...m, content: m.content.map((c) => (c.type === "image" ? { type: "text" as const, text: "[已清理：图片]" } : c)) };
  }
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
