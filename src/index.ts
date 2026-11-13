import readline from "node:readline/promises";
import { bootstrap, orExit } from "./bootstrap.js";
import { createPiConversationFactory } from "./conversation-factory.js";
import { openDb } from "./db/open.js";
import { summarizeArgs } from "./trace/session-events.js";

const { config, logger, events } = bootstrap();
const db = openDb(config.dbPath); // one SQLite file holds every piece of state
// The CLI has no group: `send` prints what the agent would post.
const makeConversation = await orExit(logger, () =>
  createPiConversationFactory(db, config, logger, async (_groupId, text) => {
    process.stdout.write(`\n[send] ${text}\n`);
  }, async (_groupId, imageId, text) => {
    process.stdout.write(`\n[send_image] ${typeof imageId === "number" ? `i${imageId}` : `artifact (${imageId.data.length} bytes)`}${text ? ` ${text}` : ""}\n`);
  }, events),
);
const conversation = await makeConversation("cli");

conversation.session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  } else if (event.type === "tool_execution_start") {
    logger.withTag("tool").debug(`${event.toolName} ${JSON.stringify(summarizeArgs(events, event.args))}`);
  }
});

events.emit("proc.start", { entry: "cli", pid: process.pid, bun: Bun.version, db: config.dbPath, model: config.model ?? "(Pi default)" });
logger.info(`database ${config.dbPath}`);
logger.info(`tools: ${conversation.session.getActiveToolNames().join(", ")} (code execution disabled)`);
logger.info("type a message; 'exit' or Ctrl+C to quit");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
rl.prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (line === "exit" || line === "quit") break;
  if (line) {
    try {
      await conversation.ask(line); // text is streamed above; `send` prints its message
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
    }
    process.stdout.write("\n");
  }
  rl.prompt();
}
rl.close();
events.emit("proc.stop", { signal: "exit" });
db.close();
