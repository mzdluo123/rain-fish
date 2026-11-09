import { describe, expect, it } from "bun:test";
import { summarizeArgs, traceSession } from "../src/trace/session-events.js";
import { memoryEventLog } from "./helpers.js";

/** A stand-in for AgentSession.subscribe that lets the test push Pi events. */
function fakePi() {
  const listeners: ((e: unknown) => void)[] = [];
  return { subscribe: (l: (e: unknown) => void) => (listeners.push(l), () => {}), push: (e: unknown) => listeners.forEach((l) => l(e)) };
}
const usage = { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, totalTokens: 126, cost: { total: 0.002 } };
const assistant = (content: unknown[], extra: object = {}) => ({ role: "assistant", provider: "anthropic", model: "claude-x", stopReason: "stop", usage, content, ...extra });

describe("summarizeArgs", () => {
  it("without content capture: identifying arguments verbatim, everything else only as a size", () => {
    const { events } = memoryEventLog();
    expect(summarizeArgs(events, { path: "/persona.md", content: "secret text", edits: [{}, {}], limit: 5, text: "hi", reply_to: "42" })).toEqual({
      path: "/persona.md",
      content_chars: 11,
      edits_count: 2,
      limit: 5,
      text_chars: 2,
      reply_to: "42",
    });
  });

  it("long values of identifying arguments are sizes too; non-objects give nothing", () => {
    const { events } = memoryEventLog();
    expect(summarizeArgs(events, { query: "q".repeat(300) })).toEqual({ query_chars: 300 });
    expect(summarizeArgs(events, undefined)).toBeUndefined();
  });

  it("with content capture: the arguments themselves", () => {
    const { events } = memoryEventLog({ captureContent: true });
    expect(summarizeArgs(events, { path: "/a.md", content: "hello" })).toEqual({ path: "/a.md", content: "hello" });
  });
});

describe("traceSession", () => {
  it("records one llm.response per model call with usage, latency, blocks and the tools it requested", () => {
    const pi = fakePi();
    const m = memoryEventLog();
    traceSession(pi as never, m.events.child({ group: "100" }), () => ({ run: "r1", turn: "t1" }));
    pi.push({ type: "message_start", message: assistant([]) });
    pi.push({ type: "message_end", message: assistant([{ type: "thinking", thinking: "..." }, { type: "text", text: "好的" }, { type: "toolCall", id: "c1", name: "send", arguments: {} }], { stopReason: "toolUse" }) });
    pi.push({ type: "message_start", message: { role: "user", content: "x" } });
    pi.push({ type: "message_end", message: { role: "user", content: "x" } }); // not a model call
    const [r, ...rest] = m.records("llm.response");
    expect(rest).toEqual([]);
    expect(r).toMatchObject({
      group: "100", run: "r1", turn: "t1", provider: "anthropic", model: "claude-x", stop_reason: "toolUse",
      usage: { input: 100, output: 20, cache_read: 5, cache_write: 1, total: 126, cost: 0.002 },
      blocks: { text: 1, thinking: 1, tool_calls: 1 }, tools: ["send"],
    });
    expect(typeof r!.ms).toBe("number");
    expect("text" in r!).toBe(false); // no content by default
  });

  it("records a failed model call's error", () => {
    const pi = fakePi();
    const m = memoryEventLog();
    traceSession(pi as never, m.events, () => ({}));
    pi.push({ type: "message_end", message: assistant([], { stopReason: "error", errorMessage: "429 rate limited" }) });
    expect(m.records("llm.response")[0]).toMatchObject({ stop_reason: "error", error: "429 rate limited" });
  });

  it("pairs tool.start/tool.end by call id with latency, error flag, result size and the terminate hint", () => {
    const pi = fakePi();
    const m = memoryEventLog();
    traceSession(pi as never, m.events, () => ({ turn: "t3" }));
    pi.push({ type: "tool_execution_start", toolCallId: "c1", toolName: "write", args: { path: "/a.md", content: "12345" } });
    pi.push({ type: "tool_execution_end", toolCallId: "c1", toolName: "write", isError: true, result: { content: [{ type: "text", text: "EFBIG: too big" }] } });
    pi.push({ type: "tool_execution_start", toolCallId: "c2", toolName: "send", args: { text: "hi" } });
    pi.push({ type: "tool_execution_end", toolCallId: "c2", toolName: "send", isError: false, result: { content: [{ type: "text", text: "Sent." }], terminate: true } });
    const [s1, e1, , e2] = m.records("tool.start", "tool.end");
    expect(s1).toMatchObject({ tool: "write", call_id: "c1", turn: "t3", args: { path: "/a.md", content_chars: 5 } });
    expect(e1).toMatchObject({ tool: "write", call_id: "c1", is_error: true, result_chars: 14 });
    expect(typeof e1!.ms).toBe("number");
    expect(e2).toMatchObject({ tool: "send", terminate: true, is_error: false });
    expect("result" in e1!).toBe(false);
  });

  it("with content capture it also keeps assistant text, tool arguments and results", () => {
    const pi = fakePi();
    const m = memoryEventLog({ captureContent: true });
    traceSession(pi as never, m.events, () => ({}));
    pi.push({ type: "message_end", message: assistant([{ type: "text", text: "你好" }]) });
    pi.push({ type: "tool_execution_start", toolCallId: "c", toolName: "send", args: { text: "hi" } });
    pi.push({ type: "tool_execution_end", toolCallId: "c", toolName: "send", isError: false, result: { content: [{ type: "text", text: "Sent." }] } });
    expect(m.records("llm.response")[0]!.text).toBe("你好");
    expect(m.records("tool.start")[0]!.args).toEqual({ text: "hi" });
    expect(m.records("tool.end")[0]!.result).toBe("Sent.");
  });

  it("records Pi's own retries and compactions", () => {
    const pi = fakePi();
    const m = memoryEventLog();
    traceSession(pi as never, m.events, () => ({}));
    pi.push({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded" });
    pi.push({ type: "compaction_start", reason: "threshold" });
    pi.push({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
    pi.push({ type: "agent_start" }); // not interesting
    expect(m.names()).toEqual(["llm.retry", "pi.compaction.start", "pi.compaction.end"]);
    expect(m.records("llm.retry")[0]).toMatchObject({ attempt: 1, max_attempts: 3, delay_ms: 2000, error: "overloaded" });
  });
});
