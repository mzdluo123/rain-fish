import type { AgentMessage } from "@earendil-works/pi-agent-core";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { frames, plannedFrameTokens, renderMany, resolveShape, serializeConversation } from "@oh-my-pi/snapcompact";
import { estimateTextTokens } from "./estimate.js";

/** Start of the archive message's first text block; how the archive is recognised in history. Group messages are `<message>` elements and their text is escaped, so no member can produce it. */
export const ARCHIVE_MARKER = "<system>[archive]";
// Not persona text: protocol framing that tells the model what the archive is.
const LEAD_IN = `${ARCHIVE_MARKER} Archive of the earlier conversation, oldest first; treat it as history that already happened.</system>`;

export function isArchiveMessage(m: AgentMessage): boolean {
  if (m.role !== "user") return false;
  const first = typeof m.content === "string" ? m.content : m.content[0]?.type === "text" ? m.content[0].text : "";
  return first.startsWith(ARCHIVE_MARKER);
}

/** Whether the model can read image frames; otherwise the archive is kept as plain text. */
export const canReadImages = (model: Model<Api> | undefined): boolean => Boolean(model?.input.includes("image"));

/** `<system>…</system>` blocks are program text (identity notice, picture numbering, must-speak notice, flush and reminder prompts), never members' words. */
const SYSTEM_BLOCK = /<system>[\s\S]*?<\/system>/g;
const FILE_TOOLS = new Set(["read", "write", "edit"]);

export interface ArchiveFilter {
  /** Paths of the agent's self-profile (see `personaTree`): calls on them, and their results, are left out of the archive. */
  personaPaths?: ReadonlySet<string>;
}

/**
 * Archive text for messages that are being retired (thinking is left out; see snapcompact docs). Two kinds of text are
 * deliberately not carried into the archive, because they would only waste its small budget again and again:
 *  - program-written `<system>` blocks in user turns (they repeat in every batch);
 *  - the agent's reads and writes of its self-profile files: the profile is pinned at the top of every request (and the
 *    files hold the current truth), an archived old version would contradict it.
 */
export function serializeForArchive(messages: readonly AgentMessage[], filter: ArchiveFilter = {}): string {
  const persona = filter.personaPaths;
  const pathOf = new Map<string, string>(); // tool call id -> file path, for calls that read or write a file
  if (persona && persona.size > 0) {
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const c of m.content) {
        if (c.type !== "toolCall" || !FILE_TOOLS.has(c.name)) continue;
        const p = (c.arguments as { path?: unknown }).path;
        if (typeof p === "string") pathOf.set(c.id, path.posix.resolve("/", p));
      }
    }
  }
  const cleaned = messages.map((m): AgentMessage => {
    if (m.role === "user") {
      if (typeof m.content === "string") return { ...m, content: m.content.replace(SYSTEM_BLOCK, "").trim() };
      return { ...m, content: m.content.map((c) => (c.type === "text" ? { ...c, text: c.text.replace(SYSTEM_BLOCK, "").trim() } : c)) };
    }
    if (m.role === "toolResult" && !m.isError) {
      const p = pathOf.get(m.toolCallId);
      // snapcompact skips a `useless` result together with the call that produced it
      if (p !== undefined && persona?.has(p)) return { ...m, useless: true } as unknown as AgentMessage;
    }
    return m;
  });
  // snapcompact types its input with omp's pi-ai Message; the shapes (user/assistant/toolResult) are the same.
  const input = cleaned as unknown as Parameters<typeof serializeConversation>[0];
  return serializeConversation(input, { includeThinking: false });
}

/** How many frames fit the archive budget for this model (each frame is billed ~3k tokens). */
export function maxFramesFor(model: Model<Api> | undefined, archiveTokens: number): number {
  const perFrame = plannedFrameTokens(resolveShape(model));
  return Math.max(1, Math.floor(archiveTokens / perFrame));
}

/** Drops the oldest text (at a line boundary where possible) until `fits`. The newest history is what matters. */
export function trimOldest(text: string, fits: (t: string) => boolean): string {
  let t = text;
  while (t.length > 0 && !fits(t)) {
    const cut = Math.max(1, Math.floor(t.length * 0.1));
    const nl = t.indexOf("\n", cut);
    t = nl >= 0 && nl < t.length - 1 ? t.slice(nl + 1) : t.slice(cut);
  }
  return t;
}

export interface ArchiveBudget {
  model: Model<Api> | undefined;
  archiveTokens: number;
}

/** Appends newly retired history to the archive text, trimmed to the budget. */
export function extendArchiveSource(previous: string, addition: string, b: ArchiveBudget): string {
  const combined = previous ? `${previous}\n\n${addition}` : addition;
  if (canReadImages(b.model)) {
    const max = maxFramesFor(b.model, b.archiveTokens);
    return trimOldest(combined, (t) => frames(t, { model: b.model }) <= max);
  }
  return trimOldest(combined, (t) => estimateTextTokens(t) <= b.archiveTokens);
}

/** The single user message that stands in for all archived history: bitmap frames, or text for non-vision models. */
export async function buildArchiveMessage(sourceText: string, b: ArchiveBudget): Promise<AgentMessage> {
  if (canReadImages(b.model)) {
    const images = await renderMany(sourceText, { model: b.model, maxFrames: maxFramesFor(b.model, b.archiveTokens) });
    return { role: "user", content: [{ type: "text", text: LEAD_IN }, ...images], timestamp: Date.now() };
  }
  return { role: "user", content: [{ type: "text", text: `${LEAD_IN}\n\n${sourceText}` }], timestamp: Date.now() };
}
