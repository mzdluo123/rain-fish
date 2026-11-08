import { backfillAll } from "./backfill.js";
import { Bot } from "./bot.js";
import { bootstrap, orExit } from "./bootstrap.js";
import { createPiConversationFactory } from "./conversation-factory.js";
import { openDb } from "./db/open.js";
import { PendingStore } from "./pending-store.js";
import { OneBotClient } from "./qq/client.js";
import { PiResponder } from "./responder.js";
import { MessageStore } from "./store.js";

const { config, logger, events } = bootstrap();

const db = openDb(config.dbPath); // messages, agent files, conversations, ... one SQLite file
const store = new MessageStore(db);
// The client and the bot reference each other: the client delivers messages, the bot sends through it.
// The agent's `send` tool posts via the bot; the responder wakes the agent for batches of queued messages.
let bot: Bot;
const responder = new PiResponder(
  orExit(logger, () => createPiConversationFactory(db, config, logger, (groupId, text, replyTo) => bot.sendText(groupId, text, replyTo), events)),
  { wake: config.wake, pending: new PendingStore(db), logger, events },
);
let backfilled = false;
const client = new OneBotClient({
  url: config.wsUrl,
  token: config.token,
  onGroupMessage: (msg) => bot.handleGroupMessage(msg),
  onSelfId: (id) => bot.noteSelfId(id),
  events,
  // The API only works once connected: backfill after the first successful connection (retried on the next one if it could not even start).
  onConnect: () => {
    if (backfilled) return;
    backfilled = true;
    backfillAll(client, store, config.groups, config.backfill, { logger, events }).catch((err) => {
      backfilled = false;
      logger.error(`history backfill failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  },
  logger,
});
bot = new Bot({ store, responder, api: client, groups: config.groups, logger, events });

events.emit("proc.start", {
  entry: "bot",
  pid: process.pid,
  bun: Bun.version,
  db: config.dbPath,
  model: config.model ?? "(Pi default)",
  groups: config.groups ? [...config.groups] : "all",
  wake: config.wake,
  context: config.context,
  backfill: config.backfill,
  trace: { dir: config.trace.dir, content: config.trace.content },
});
process.on("uncaughtExceptionMonitor", (err) => events.emit("proc.crash", { error: err })); // observes only: the default crash behaviour is unchanged
logger.info(`database ${config.dbPath} · log level ${config.logLevel} · groups ${config.groups ? [...config.groups].join(",") : "all"}`);
responder.restore((groupId) => !config.groups || config.groups.has(groupId)); // messages that were queued when the last process stopped
client.start();

const shutdown = (signal: string) => {
  logger.info("shutting down");
  events.emit("proc.stop", { signal });
  client.stop();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
