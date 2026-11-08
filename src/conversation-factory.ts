import type { Database } from "bun:sqlite";
import { createAgent } from "./agent.js";
import { PiConversation } from "./conversation.js";
import { ConversationStore } from "./conversation-store.js";
import { createModelRegistry, resolveModel } from "./model.js";
import { MessageStore } from "./store.js";
import type { Config, Logger } from "./types.js";
import { VirtualFs } from "./vfs.js";

/**
 * Wires everything an agent conversation needs: the model chosen by `MODEL`, the database-backed
 * filesystem and message search, persisted history, and the context-management settings.
 * Throws (at startup, not on the first message) if `MODEL` does not exist.
 */
export function createPiConversationFactory(db: Database, config: Config, logger: Logger) {
  const registry = createModelRegistry();
  const model = config.model ? resolveModel(registry, config.model) : undefined;
  if (model && !registry.hasConfiguredAuth(model)) {
    logger.warn(`no credentials for provider "${model.provider}": replies will fail until an API key is configured (see .env.example)`);
  }
  logger.info(`model ${config.model ?? "(Pi default)"} · context: prune >${config.context.pruneMinTokens}t outside ${config.context.recentTokens}t recent, snap-compact at ${config.context.compactTokens}t`);

  const fs = new VirtualFs(db);
  const store = new MessageStore(db);
  const conversations = new ConversationStore(db);
  const toolLog = logger.withTag("tool");

  return async (groupId: string): Promise<PiConversation> => {
    const { session } = await createAgent({ fs, store, model, modelRegistry: registry });
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") toolLog.debug(`${event.toolName} ${JSON.stringify(event.args)}`);
    });
    logger.info(`started agent session for ${groupId}`);
    return PiConversation.create({ groupId, session, store: conversations, context: config.context, logger });
  };
}
