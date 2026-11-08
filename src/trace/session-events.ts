import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { EventLog } from "../types.js";
import { preview } from "./event-log.js";

/** Argument names whose (short) values are identifiers rather than content: always safe and useful to record. */
const IDENTIFYING_ARGS = new Set(["path", "pattern", "glob", "query", "sender", "since", "until", "limit", "reply_to", "offset", "ignoreCase", "literal"]);

/**
 * What a tool call asked for. By default only shape: identifying arguments verbatim, everything else as a
 * size (`content_chars`, `edits_count`). With content capture on, the arguments themselves (clipped).
 */
export function summarizeArgs(events: EventLog, args: unknown): unknown {
  if (events.captureContent) return args;
  if (typeof args !== "object" || args === null) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (IDENTIFYING_ARGS.has(k) && (typeof v === "string" ? v.length <= 200 : typeof v !== "object")) out[k] = v;
    else if (typeof v === "string") out[`${k}_chars`] = v.length;
    else if (Array.isArray(v)) out[`${k}_count`] = v.length;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else out[`${k}_kind`] = typeof v;
  }
  return out;
}

const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && "text" in c && typeof c.text === "string" ? c.text : "")).join("") : "";

/**
 * Turns Pi's session events into trace events: one `llm.response` per model call (model, stop reason,
 * token usage and cost, latency, what it produced), a `tool.start`/`tool.end` pair per tool call (arguments
 * summary, latency, error flag, result size), and retries/compactions Pi performs by itself.
 * `ctx` supplies the current `run`/`turn` ids so these events line up with the conversation's own.
 * Returns the unsubscribe function.
 */
export function traceSession(session: Pick<AgentSession, "subscribe">, events: EventLog, ctx: () => Record<string, unknown>): () => void {
  const toolStarted = new Map<string, number>();
  let llmStarted = Date.now();
  return session.subscribe((e) => {
    switch (e.type) {
      case "message_start":
        if (e.message.role === "assistant") llmStarted = Date.now();
        return;
      case "message_end": {
        const m = e.message;
        if (m.role !== "assistant") return;
        const blocks = { text: 0, thinking: 0, tool_calls: 0 };
        const tools: string[] = [];
        for (const c of m.content) {
          if (c.type === "text") blocks.text++;
          else if (c.type === "thinking") blocks.thinking++;
          else if (c.type === "toolCall") {
            blocks.tool_calls++;
            tools.push(c.name);
          }
        }
        events.emit("llm.response", {
          ...ctx(),
          provider: m.provider,
          model: m.model,
          stop_reason: m.stopReason,
          ms: Date.now() - llmStarted,
          usage: { input: m.usage.input, output: m.usage.output, cache_read: m.usage.cacheRead, cache_write: m.usage.cacheWrite, total: m.usage.totalTokens, cost: m.usage.cost.total },
          blocks,
          tools,
          error: m.errorMessage,
          text: preview(events, textOf(m.content)),
        });
        return;
      }
      case "tool_execution_start":
        toolStarted.set(e.toolCallId, Date.now());
        events.emit("tool.start", { ...ctx(), tool: e.toolName, call_id: e.toolCallId, args: summarizeArgs(events, e.args) });
        return;
      case "tool_execution_end": {
        const t0 = toolStarted.get(e.toolCallId);
        toolStarted.delete(e.toolCallId);
        const text = textOf(e.result?.content);
        events.emit("tool.end", {
          ...ctx(),
          tool: e.toolName,
          call_id: e.toolCallId,
          ms: t0 === undefined ? undefined : Date.now() - t0,
          is_error: e.isError,
          result_chars: text.length,
          terminate: e.result?.terminate === true ? true : undefined,
          result: preview(events, text),
        });
        return;
      }
      case "auto_retry_start":
        events.emit("llm.retry", { ...ctx(), attempt: e.attempt, max_attempts: e.maxAttempts, delay_ms: e.delayMs, error: e.errorMessage });
        return;
      case "compaction_start":
        events.emit("pi.compaction.start", { ...ctx(), reason: e.reason });
        return;
      case "compaction_end":
        events.emit("pi.compaction.end", { ...ctx(), reason: e.reason, aborted: e.aborted, will_retry: e.willRetry, error: e.errorMessage });
        return;
      default:
        return;
    }
  });
}
