import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "../src/types.js";
import { openDb } from "../src/db/open.js";
import { MessageStore } from "../src/store.js";
import { ImageStore } from "../src/image-store.js";
import { RunBudget } from "../src/run-budget.js";
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
  const sentImages: { imageId: number; text?: string; replyTo?: string }[] = [];
  const sendImage = async (imageId: number, text?: string, replyTo?: string) => {
    if (sendError) throw new Error(sendError);
    sentImages.push({ imageId, text, replyTo });
  };
  const images = new ImageStore(db);
  const budget = new RunBudget(6, 0);
  return { db, fs, store, systemPrompt, groupId: "100", send, sent, sendImage, sentImages, images, budget };
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

// ---- pictures -------------------------------------------------------------------------

/** A real, decodable w x h RGBA PNG (a gradient, so it does not compress to nothing). */
export function pngBytes(width: number, height: number): Buffer {
  const crcTable = (() => {
    const t: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t.push(c >>> 0);
    }
    return t;
  })();
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const o = y * (1 + width * 4);
    for (let x = 0; x < width; x++) rows.set([x & 255, y & 255, (x ^ y) & 255, 255], o + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", require("node:zlib").deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Puts a finished tool call on `path` into the agent session's context window, as if the model had made it in an earlier step
 * (`read` by default; `args` can add offset/limit, `isError` makes it a failed call). Tests call the tools directly, so this
 * is how they satisfy "the file must have been read before an edit".
 */
export function markSeen(
  session: { agent: { state: { messages: unknown[] } } },
  path: string,
  opts: { name?: "read" | "write" | "edit"; args?: Record<string, unknown>; isError?: boolean; timestamp?: number } = {},
): void {
  const id = `seen-${Math.random().toString(36).slice(2)}`;
  const name = opts.name ?? "read";
  const timestamp = opts.timestamp ?? Date.now();
  session.agent.state.messages = [
    ...session.agent.state.messages,
    { role: "assistant", content: [{ type: "toolCall", id, name, arguments: { path, ...opts.args } }], timestamp },
    { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "" }], isError: opts.isError ?? false, timestamp },
  ];
}
