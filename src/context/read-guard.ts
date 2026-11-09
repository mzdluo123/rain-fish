import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { VirtualFs } from "../vfs.js";

/** Tools whose successful result shows the agent a file's content (a `write` shows what the agent itself put there). */
const SEEN_BY: ReadonlySet<string> = new Set(["read", "write", "edit"]);

/**
 * When the live context last showed the agent the file `p`, in ms: the newest successful `read`, `write` or `edit` of it among
 * `messages`, or undefined if there is none. `messages` is the context window itself, so whatever compaction retired, or a
 * rolled-back turn, or a restart did not restore, does not count. A read with `offset`/`limit` showed only a part and does not
 * count either. A result of the batch still running is not in `messages` yet: read in an earlier step, edit in a later one.
 */
export function lastSeen(messages: readonly AgentMessage[], p: string): number | undefined {
  const target = path.posix.resolve("/", p);
  const calls = new Map<string, string>(); // tool call id -> tool name, for calls on `target` that show the whole file
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const c of m.content) {
      if (c.type !== "toolCall" || !SEEN_BY.has(c.name)) continue;
      const a = c.arguments as { path?: unknown; offset?: unknown; limit?: unknown };
      if (typeof a.path !== "string" || path.posix.resolve("/", a.path) !== target) continue;
      if (c.name === "read" && (a.offset != null || a.limit != null)) continue; // models often send `null` for an omitted optional argument
      calls.set(c.id, c.name);
    }
  }
  let seen: number | undefined;
  for (const m of messages) {
    if (m.role !== "toolResult" || m.isError || !calls.has(m.toolCallId)) continue;
    seen = Math.max(seen ?? 0, m.timestamp);
  }
  return seen;
}

/**
 * Throws unless the agent has the current content of `p` in its context window: it must have read the file (or written / edited it)
 * since the context was last cut, and nobody changed the file after that. Used before an `edit` and before a `write` over an existing
 * file: both replace text the agent has to be able to see. The error says what to do.
 */
export function assertSeen(fs: VirtualFs, messages: readonly AgentMessage[], p: string): void {
  const n = path.posix.resolve("/", p);
  const seen = lastSeen(messages, n);
  if (seen === undefined) {
    throw new Error(
      `EACCES: you have not read '${n}' in the part of the conversation you can still see (or only a slice of it), so it was not changed. ` +
        `Call read on '${n}' first, in a step of its own before changing it, look at the current text, then edit or write it.`,
    );
  }
  const mtime = fs.stat(n)?.mtime; // seconds
  if (mtime !== undefined && mtime > Math.floor(seen / 1000)) {
    throw new Error(`ESTALE: '${n}' was changed after you last saw it, so it was not changed. Call read on '${n}' again, then change the current text.`);
  }
}
