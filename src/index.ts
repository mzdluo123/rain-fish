import readline from "node:readline/promises";
import { bootstrap, orExit } from "./bootstrap.js";
import { createPiConversationFactory } from "./conversation-factory.js";
import { openDb } from "./db/open.js";

const { config, logger } = bootstrap();
const db = openDb(config.dbPath); // one SQLite file holds every piece of state
const conversation = await orExit(logger, () => createPiConversationFactory(db, config, logger))("cli");

conversation.session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  } else if (event.type === "tool_execution_start") {
    logger.withTag("tool").info(`${event.toolName} ${JSON.stringify(event.args)}`);
  }
});

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
      await conversation.ask(line); // the reply was already streamed above
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
    }
    process.stdout.write("\n");
  }
  rl.prompt();
}
rl.close();
db.close();
