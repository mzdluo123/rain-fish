import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "../src/types.js";
import { openDb } from "../src/db/open.js";
import { MessageStore } from "../src/store.js";
import { VirtualFs } from "../src/vfs.js";
import { JsonlEventLog } from "../src/trace/event-log.js";

/** A fresh in-memory database with the agent's (empty) filesystem and message store, a system prompt, and a `send` that records (or fails with `sendError`). */
export function makeEnv(systemPrompt = "# Persona\nYou are TESTBOT.", sendError?: string) {
  const db = openDb(":memory:");
  const fs = new VirtualFs(db);
  const store = new MessageStore(db);
  const sent: { text: string; replyTo?: string }[] = [];
  const send = async (text: string, replyTo?: string) => {
    if (sendError) throw new Error(sendError);
    sent.push({ text, replyTo });
  };
  return { db, fs, store, systemPrompt, groupId: "100", send, sent };
}

export interface LogEntry {
  level: "debug" | "info" | "success" | "warn" | "error";
  msg: string;
}

/** A Logger that records instead of printing. `messages` is a live array of the message texts. */
export function recordingLogger() {
  const entries: LogEntry[] = [];
  const messages: string[] = [];
  const at =
    (level: LogEntry["level"]) =>
    (msg: string) => {
      entries.push({ level, msg });
      messages.push(msg);
    };
  const logger: Logger = {
    debug: at("debug"),
    info: at("info"),
    success: at("success"),
    warn: at("warn"),
    error: at("error"),
    withTag: () => logger,
  };
  return { logger, entries, messages };
}

// ---- agent message builders (Pi message shapes) ----------------------------------------


let clock = 1_700_000_000_000;
export const userMsg = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: ++clock });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistantBase = { api: "openai-responses", provider: "openai", model: "gpt-5.5", usage } as const;
export const assistantText = (text: string): AgentMessage => ({ role: "assistant", ...assistantBase, content: [{ type: "text", text }], stopReason: "stop", timestamp: ++clock });
export const assistantCall = (id: string, name: string, args: Record<string, unknown>): AgentMessage => ({
  role: "assistant", ...assistantBase, content: [{ type: "toolCall", id, name, arguments: args as never }], stopReason: "toolUse", timestamp: ++clock,
});
export const assistantError = (errorMessage: string): AgentMessage => ({ role: "assistant", ...assistantBase, content: [], stopReason: "error", errorMessage, timestamp: ++clock });
export const toolResultMsg = (id: string, name: string, text: string): AgentMessage => ({
  role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: ++clock,
});
/** n tokens' worth of text under the estimator (1 token per CJK character). */
export const tokensOf = (n: number, ch = "字") => ch.repeat(n);

// ---- event log -------------------------------------------------------------------------

/** An event log that keeps its records in memory (parsed back from the JSON lines it would write). */
export function memoryEventLog(opts: { captureContent?: boolean } = {}) {
  const lines: string[] = [];
  const events = JsonlEventLog.create({ write: (l) => void lines.push(l) }, { captureContent: opts.captureContent ?? false, boot: "test" });
  const all = () => lines.map((l) => JSON.parse(l) as Record<string, any>);
  return {
    events,
    /** All records, or only those whose `ev` matches. */
    records: (...evs: string[]) => all().filter((r) => evs.length === 0 || evs.includes(r.ev)),
    /** Just the event names, in order. */
    names: (...evs: string[]) => all().filter((r) => evs.length === 0 || evs.includes(r.ev)).map((r) => r.ev as string),
  };
}

/** Built-in model catalog only: no `models.json`, no network, empty credential file in a temp dir (never the real ~/.pi/agent). */
export const testModelRuntime = (): Promise<ModelRuntime> =>
  ModelRuntime.create({ modelsPath: null, authPath: path.join(mkdtempSync(path.join(tmpdir(), "rainfish-auth-")), "auth.json"), refreshOnCreate: false });
