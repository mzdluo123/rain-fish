import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createAgent } from "./agent.js";
import { PiConversation } from "./conversation.js";
import { ConversationStore } from "./conversation-store.js";
import { createModelRegistry, resolveModel } from "./model.js";
import { MessageStore } from "./store.js";
import type { Config, GroupSender, Logger } from "./types.js";
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

export function createPiConversationFactory(db: Database, config: Config, logger: Logger, send: GroupSender) {
  loadSystemPrompt(config.promptFile); // fail at startup, not on the first message
  const registry = createModelRegistry();
  const model = config.model ? resolveModel(registry, config.model) : undefined;
  if (model && !registry.hasConfiguredAuth(model)) {
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
      modelRegistry: registry,
    });
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") toolLog.debug(`${event.toolName} ${JSON.stringify(event.args)}`);
    });
    logger.info(`started agent session for ${groupId}`);
    return PiConversation.create({ groupId, session, store: conversations, context: config.context, logger });
  };
}
