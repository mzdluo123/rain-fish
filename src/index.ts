import path from "node:path";
import readline from "node:readline/promises";
import { createSandboxedAgent } from "./agent.js";

const sandboxDir = path.resolve(process.env.SANDBOX_DIR ?? "workspace");
const { session, sandbox } = await createSandboxedAgent(sandboxDir);

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  } else if (event.type === "tool_execution_start") {
    process.stdout.write(`\n[tool] ${event.toolName} ${JSON.stringify(event.args)}\n`);
  }
});

console.log(`Sandbox: ${sandbox.root}`);
console.log(`Tools:   ${session.getActiveToolNames().join(", ")}  (code execution disabled)`);
console.log("Type a message, Ctrl+C / 'exit' to quit.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
rl.prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (line === "exit" || line === "quit") break;
  if (line) {
    await session.prompt(line);
    const last = session.state.messages.at(-1);
    if (last?.role === "assistant" && last.stopReason === "error") {
      process.stdout.write(`\n[error] ${last.errorMessage}`);
    }
    process.stdout.write("\n");
  }
  rl.prompt();
}
rl.close();
