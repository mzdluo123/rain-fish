import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { frames, plannedFrameTokens, renderMany, resolveShape, serializeConversation } from "@oh-my-pi/snapcompact";
import { estimateTextTokens } from "./estimate.js";

/** Start of the archive message's first text block; how the archive is recognised in history. */
export const ARCHIVE_MARKER = "[归档]";
// Not persona text: protocol framing that tells the model what the archive is.
const LEAD_IN = `${ARCHIVE_MARKER} 以下是此前对话的归档，按时间从早到晚排列，请当作已经发生的历史。`;

export function isArchiveMessage(m: AgentMessage): boolean {
  if (m.role !== "user") return false;
  const first = typeof m.content === "string" ? m.content : m.content[0]?.type === "text" ? m.content[0].text : "";
  return first.startsWith(ARCHIVE_MARKER);
}

/** Whether the model can read image frames; otherwise the archive is kept as plain text. */
export const canReadImages = (model: Model<any> | undefined): boolean => Boolean(model?.input.includes("image"));

/** Archive text for messages that are being retired (thinking is left out; see snapcompact docs). */
export function serializeForArchive(messages: readonly AgentMessage[]): string {
  // snapcompact types its input with omp's pi-ai Message; the shapes (user/assistant/toolResult) are the same.
  const input = messages as unknown as Parameters<typeof serializeConversation>[0];
  return serializeConversation(input, { includeThinking: false });
}

/** How many frames fit the archive budget for this model (each frame is billed ~3k tokens). */
export function maxFramesFor(model: Model<any> | undefined, archiveTokens: number): number {
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
  model: Model<any> | undefined;
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
