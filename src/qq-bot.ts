import { createAgent } from "./agent.js";
import { Bot } from "./bot.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/open.js";
import { OneBotClient } from "./qq/client.js";
import { PiResponder } from "./responder.js";
import { MessageStore } from "./store.js";
import { VirtualFs } from "./vfs.js";

const config = loadConfig();
const log = (m: string) => console.log(`[qq] ${m}`);

const db = openDb(config.dbPath); // messages, agent files, ... one SQLite file
const fs = new VirtualFs(db);
const store = new MessageStore(db);
const responder = new PiResponder(async () => (await createAgent({ fs, store })).session);

// The client and the bot reference each other: the client delivers messages, the bot sends replies through it.
let bot: Bot;
const client = new OneBotClient({
  url: config.wsUrl,
  token: config.token,
  onGroupMessage: (msg) => bot.handleGroupMessage(msg),
  log,
});
bot = new Bot({ store, responder, api: client, groups: config.groups, log });
client.start();

process.on("SIGINT", () => {
  client.stop();
  db.close();
  process.exit(0);
});
