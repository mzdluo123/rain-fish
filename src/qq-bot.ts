import { Bot } from "./bot.js";
import { bootstrap, orExit } from "./bootstrap.js";
import { createPiConversationFactory } from "./conversation-factory.js";
import { openDb } from "./db/open.js";
import { OneBotClient } from "./qq/client.js";
import { PiResponder } from "./responder.js";
import { MessageStore } from "./store.js";

const { config, logger } = bootstrap();

const db = openDb(config.dbPath); // messages, agent files, conversations, ... one SQLite file
const store = new MessageStore(db);
// The client and the bot reference each other: the client delivers messages, the bot sends through it.
// The agent's `send` tool posts via the bot; the responder wakes the agent for batches of queued messages.
let bot: Bot;
const responder = new PiResponder(
  orExit(logger, () => createPiConversationFactory(db, config, logger, (groupId, text, replyTo) => bot.sendText(groupId, text, replyTo))),
  { wake: config.wake, logger },
);
const client = new OneBotClient({
  url: config.wsUrl,
  token: config.token,
  onGroupMessage: (msg) => bot.handleGroupMessage(msg),
  logger,
});
bot = new Bot({ store, responder, api: client, groups: config.groups, logger });

logger.info(`database ${config.dbPath} · log level ${config.logLevel} · groups ${config.groups ? [...config.groups].join(",") : "all"}`);
client.start();

const shutdown = () => {
  logger.info("shutting down");
  client.stop();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
