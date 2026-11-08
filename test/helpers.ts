import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Logger } from "../src/types.js";
import { openDb } from "../src/db/open.js";
import { AGENT_FILE } from "../src/agent.js";
import { MessageStore } from "../src/store.js";
import { VirtualFs } from "../src/vfs.js";

/** A fresh in-memory database with the agent's filesystem (seeded with /agent.md) and message store. */
export function makeEnv(agentMd: string | null = "# Persona\nYou are TESTBOT.") {
  const db = openDb(":memory:");
  const fs = new VirtualFs(db);
  const store = new MessageStore(db);
  if (agentMd !== null) fs.writeFile(AGENT_FILE, agentMd);
  return { db, fs, store };
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
  role: "assistant", ...assistantBase, content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", timestamp: ++clock,
});
export const assistantError = (errorMessage: string): AgentMessage => ({ role: "assistant", ...assistantBase, content: [], stopReason: "error", errorMessage, timestamp: ++clock });
export const toolResultMsg = (id: string, name: string, text: string): AgentMessage => ({
  role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: ++clock,
});
/** n tokens' worth of text under the estimator (1 token per CJK character). */
export const tokensOf = (n: number, ch = "字") => ch.repeat(n);
