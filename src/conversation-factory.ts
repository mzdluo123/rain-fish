import type { Database } from "bun:sqlite";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { createAgent } from "./agent.js";
import { PiConversation } from "./conversation.js";
import { ConversationStore } from "./conversation-store.js";
import { estimateContextTokens } from "./context/estimate.js";
import { pruneExpensive } from "./context/prune.js";
import { createModelRuntime, resolveModel } from "./model.js";
import { MessageStore } from "./store.js";
import { noopEventLog } from "./trace/event-log.js";
import type { Config, EventLog, GroupSender, Logger } from "./types.js";
import { VirtualFs } from "./vfs.js";

/**
 * Wires everything an agent conversation needs: the model chosen by `MODEL`, the database-backed
 * filesystem and message search, persisted history, and the context-management settings.
 * Throws (at startup, not on the first message) if `MODEL` does not exist.
 */
/** Reads the system prompt file; a missing or empty file is a startup error, not a silent default persona. */
export function loadSystemPrompt(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    throw new Error(`System prompt file not found: ${file} (set PROMPT_FILE)`);
  }
  if (!text.trim()) throw new Error(`System prompt file is empty: ${file}`);
  return text;
}

/** The same estimate the compaction thresholds use: system prompt + the pruned view of the live messages. */
function estimateContext(session: AgentSession, config: Config): number {
  const c = config.context;
  const view = pruneExpensive(session.agent.state.messages, { recentTokens: c.recentTokens, minBlockTokens: c.pruneMinTokens });
  return estimateContextTokens(session.systemPrompt, view);
}

/** One line per model call: model, stop reason, latency, context size (the estimate compaction uses) vs thresholds, API tokens, cost and what it produced. Text only at debug (never above). */
function logLlmCall(log: Logger, groupId: string, m: AssistantMessage, ms: number, ctx: { tokens: number; window?: number; compact: number }): void {
  const tools = m.content.flatMap((c) => (c.type === "toolCall" ? [c.name] : []));
  const thinking = m.content.some((c) => c.type === "thinking");
  const u = m.usage;
  const pct = (n: number, of: number) => `${((n / of) * 100).toFixed(1)}%`;
  const line =
    `group ${groupId}: ${m.model} ${m.stopReason} ${(ms / 1000).toFixed(1)}s · context ~${ctx.tokens} (${pct(ctx.tokens, ctx.compact)} of compact@${ctx.compact}${ctx.window ? `, ${pct(ctx.tokens, ctx.window)} of ${ctx.window} window` : ""}) · in ${u.input} out ${u.output} cache ${u.cacheRead}r/${u.cacheWrite}w · $${u.cost.total.toFixed(4)}` +
    `${thinking ? " · thinking" : ""}${tools.length ? ` · tools: ${tools.join(", ")}` : ""}`;
  if (m.stopReason === "error" || m.stopReason === "aborted") log.error(`${line}: ${m.errorMessage ?? m.stopReason}`);
  else log.info(line);
  const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
  if (text) log.debug(`group ${groupId}: text: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`);
}

export async function createPiConversationFactory(db: Database, config: Config, logger: Logger, send: GroupSender, events: EventLog = noopEventLog) {
  loadSystemPrompt(config.promptFile); // fail at startup, not on the first message
  const runtime = await createModelRuntime();
  const model = config.model ? resolveModel(runtime, config.model) : undefined;
  if (model && !runtime.hasConfiguredAuth(model.provider)) {
    logger.warn(`no credentials for provider "${model.provider}": replies will fail until an API key is configured (see .env.example)`);
  }
  logger.info(`prompt ${config.promptFile} · model ${config.model ?? "(Pi default)"} · context: prune >${config.context.pruneMinTokens}t outside ${config.context.recentTokens}t recent, snap-compact at ${config.context.compactTokens}t`);

  const fs = new VirtualFs(db);
  const store = new MessageStore(db);
  const conversations = new ConversationStore(db);
  const toolLog = logger.withTag("tool");
  const llmLog = logger.withTag("llm");

  return async (groupId: string): Promise<PiConversation> => {
    // Re-read per conversation: an edit applies to groups whose conversation starts after it.
    const { session } = await createAgent({
      systemPrompt: loadSystemPrompt(config.promptFile),
      fs,
      store,
      groupId,
      send: (text, replyTo) => send(groupId, text, replyTo),
      model,
      modelRuntime: runtime,
      thinkingLevel: config.thinkingLevel,
    });
    let llmStarted = Date.now();
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") toolLog.debug(`${event.toolName} ${JSON.stringify(event.args)}`);
      else if (event.type === "message_start" && event.message.role === "assistant") llmStarted = Date.now();
      else if (event.type === "message_end" && event.message.role === "assistant") logLlmCall(llmLog, groupId, event.message, Date.now() - llmStarted, { tokens: estimateContext(session, config), window: session.model?.contextWindow, compact: config.context.compactTokens });
      else if (event.type === "auto_retry_start") llmLog.warn(`group ${groupId}: retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms: ${event.errorMessage}`);
    });
    logger.info(`started agent session for ${groupId}`);
    events.emit("session.start", { group: groupId, model: session.model ? `${session.model.provider}/${session.model.id}` : undefined, tools: session.getActiveToolNames(), system_prompt_chars: session.systemPrompt.length });
    return PiConversation.create({ groupId, session, store: conversations, context: config.context, logger, events });
  };
}
