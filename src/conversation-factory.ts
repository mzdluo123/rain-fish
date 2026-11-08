import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createAgent } from "./agent.js";
import { PiConversation } from "./conversation.js";
import { ConversationStore } from "./conversation-store.js";
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
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") toolLog.debug(`${event.toolName} ${JSON.stringify(event.args)}`);
    });
    logger.info(`started agent session for ${groupId}`);
    events.emit("session.start", { group: groupId, model: session.model ? `${session.model.provider}/${session.model.id}` : undefined, tools: session.getActiveToolNames(), system_prompt_chars: session.systemPrompt.length });
    return PiConversation.create({ groupId, session, store: conversations, context: config.context, logger, events });
  };
}
