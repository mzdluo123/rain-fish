import { createInterface } from "node:readline";
import { ConversationStore } from "./conversation-store.js";
import { ColabStore } from "./colab-store.js";
import { createColabCli } from "./colab/cli.js";
import { ColabRunner } from "./colab/runner.js";
import { backfillAll } from "./backfill.js";
import { Bot } from "./bot.js";
import { bootstrap, orExit } from "./bootstrap.js";
import { createPiConversationFactory } from "./conversation-factory.js";
import { openDb } from "./db/open.js";
import { PendingStore } from "./pending-store.js";
import { OneBotClient } from "./qq/client.js";
import { createImageSource } from "./images.js";
import { ImageStore } from "./image-store.js";
import { createPictureArchive } from "./picture-archive.js";
import { createModelImage } from "./image-resize.js";
import { PiResponder } from "./responder.js";
import { SpeakStore } from "./speak-store.js";
import { MessageStore } from "./store.js";
import { VirtualFs } from "./vfs.js";
import { createWakeRules } from "./wake-rules.js";

const { config, logger, events } = bootstrap();

const db = openDb(config.dbPath); // messages, agent files, conversations, ... one SQLite file
const store = new MessageStore(db);
// The client and the bot reference each other: the client delivers messages, the bot sends through it.
// The agent's `send` tool posts via the bot; the responder wakes the agent for batches of queued messages.
let bot: Bot;
const imageStore = new ImageStore(db);
const modelImage = createModelImage({ maxPixels: config.images.modelMaxPixels, maxEdge: config.images.modelMaxEdge, detailMaxPixels: config.images.detailMaxPixels });
const imageSource = config.images.maxBytes > 0 && config.images.maxPerRun > 0 ? createImageSource({ ...config.images, logger }) : undefined;
// Pictures are kept as they arrive (so they outlive QQ's URLs; the ORIGINAL is stored, the model gets a scaled-down copy). With
// IMAGE_STORE_MAX_BYTES=0 only the download at wake-up remains, scaled the same way.
const pictures = config.images.maxBytes > 0 && config.images.storeMaxBytes > 0 ? createPictureArchive({ source: imageSource ?? createImageSource({ ...config.images, maxPerRun: 1, logger }), store: imageStore, maxBytes: config.images.storeMaxBytes, shrink: modelImage, logger }) : undefined;
const promptImages = imageSource && {
  maxPerRun: imageSource.maxPerRun,
  async load(url: string) {
    const img = await imageSource.load(url);
    if (!img) return undefined;
    const shown = await modelImage({ data: Buffer.from(img.data, "base64"), mime: img.mimeType });
    return { type: "image" as const, data: shown.data.toString("base64"), mimeType: shown.mime };
  },
};
{
  const evicted = imageStore.evict(config.images.storeMaxBytes); // the cap may have been lowered (or set to 0) since the last run
  if (evicted > 0) logger.info(`deleted ${evicted} stored picture(s) to fit IMAGE_STORE_MAX_BYTES=${config.images.storeMaxBytes}`);
}
// `run_python`: one Colab CPU runtime shared by every group, created on the first run and released when idle (COLAB_*).
const colab = config.colab.enabled ? new ColabRunner({ cli: createColabCli(config.colab.cliPath), store: new ColabStore(db), config: config.colab, logger, events }) : undefined;
if (colab) {
  logger.info(`run_python enabled: Colab session ${config.colab.sessionName}, released after ${config.colab.idleMs / 1000}s idle`);
  colab.restore().catch((err) => logger.error(`colab: startup clean-up failed: ${err instanceof Error ? err.message : String(err)}`));
}
const makeConversation = await orExit(logger, () =>
  createPiConversationFactory(db, config, logger, (groupId, text, replyTo) => bot.sendText(groupId, text, replyTo), (groupId, imageId, text, replyTo) => bot.sendImage(groupId, imageId, text, replyTo), events, colab && ((req) => colab.run(req))),
);
const wakeRules = createWakeRules({ fs: new VirtualFs(db), logger }); // /wake-rules.yaml in the agent's filesystem: created if missing, reloaded when the agent edits it
const responder = new PiResponder(
  makeConversation,
  { wake: config.wake, weigh: wakeRules.weigh, speakEveryRuns: config.speakEveryRuns, speakStore: new SpeakStore(db), pending: new PendingStore(db), images: promptImages, pictures, logger, events },
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
bot = new Bot({ store, images: imageStore, pictures, responder, api: client, groups: config.groups, logger, events });

events.emit("proc.start", {
  entry: "bot",
  pid: process.pid,
  bun: Bun.version,
  db: config.dbPath,
  model: config.model ?? "(Pi default)",
  groups: config.groups ? [...config.groups] : "all",
  wake: config.wake,
  speakEveryRuns: config.speakEveryRuns,
  context: config.context,
  images: config.images,
  backfill: config.backfill,
  trace: { dir: config.trace.dir, content: config.trace.content },
});
process.on("uncaughtExceptionMonitor", (err) => events.emit("proc.crash", { error: err })); // observes only: the default crash behaviour is unchanged
logger.info(`database ${config.dbPath} · log level ${config.logLevel} · groups ${config.groups ? [...config.groups].join(",") : "all"}`);
responder.restore((groupId) => !config.groups || config.groups.has(groupId)); // messages that were queued when the last process stopped
client.start();

// Console commands (stdin lines, e.g. in the tmux pane): `compact` archives every group's whole context right away;
// `clear` forgets it entirely (live messages and archive; the chat log, files and profile stay); `colab-stop` releases the Colab runtime now.
const conversationStore = new ConversationStore(db);
createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = line.trim();
  if (cmd === "colab-stop") {
    if (!colab) logger.info("colab-stop: run_python is not enabled");
    else colab.stop("console").then(() => logger.info("colab-stop: done"), (err) => logger.error(`colab-stop failed: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  if (cmd !== "compact" && cmd !== "clear") return;
  const ids = config.groups ? [...config.groups] : conversationStore.groupIds();
  if (ids.length === 0) logger.info(`${cmd}: no conversation`);
  for (const id of ids) {
    if (cmd === "clear") {
      responder.clear(id).then(
        (n) => logger.info(n === undefined ? `clear: group ${id}: not supported` : `clear: group ${id}: dropped ${n} message(s) and the archive`),
        (err) => logger.error(`clear: group ${id} failed: ${err instanceof Error ? err.message : String(err)}`),
      );
      continue;
    }
    responder.compact(id).then(
      (r) => logger.info(r ? `compact: group ${id}: archived ${r.archived} message(s), ~${r.tokensBefore} -> ~${r.tokensAfter} tokens` : `compact: group ${id}: nothing to archive`),
      (err) => logger.error(`compact: group ${id} failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
});

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info("shutting down");
  events.emit("proc.stop", { signal });
  client.stop();
  // Release the Colab runtime (bounded: `colab stop` has its own timeout) so it does not keep running unused.
  await colab?.shutdown().catch((err) => logger.error(`colab: release on shutdown failed: ${err instanceof Error ? err.message : String(err)}`));
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
