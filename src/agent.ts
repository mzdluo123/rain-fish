import {
  createAgentSession,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { access } from "node:fs/promises";
import { createSandboxOperations, Sandbox } from "./sandbox.js";

/** The only tools the agent may ever use. `bash` is deliberately absent. */
export const ALLOWED_TOOLS = ["read", "write", "edit", "ls", "find", "grep"] as const;

/** System-prompt file, read from the sandbox root. All prompt text lives there, none in code. */
export const AGENT_FILE = "agent.md";

export async function createSandboxedAgent(sandboxDir: string): Promise<{ session: AgentSession; sandbox: Sandbox }> {
  const sandbox = new Sandbox(sandboxDir);
  // Pi treats a non-existent path as literal prompt text, so verify the file first.
  const agentFile = await sandbox.resolve(AGENT_FILE);
  await access(agentFile).catch(() => {
    throw new Error(`Missing ${AGENT_FILE} in sandbox root: ${sandbox.root}`);
  });
  const ops = createSandboxOperations(sandbox);
  const cwd = sandbox.root;

  // Disable everything that could smuggle in extra tools or instructions
  // (extensions can register bash-like tools; skills/context files come from outside the sandbox).
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: agentFile, // Pi reads the file and uses its content as the system prompt
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    // Allowlist: built-in `bash` is never enabled.
    tools: [...ALLOWED_TOOLS],
    // Same-named custom definitions replace the built-ins with path-confined versions.
    customTools: [
      createReadToolDefinition(cwd, { operations: ops.read }),
      createWriteToolDefinition(cwd, { operations: ops.write }),
      createEditToolDefinition(cwd, { operations: ops.edit }),
      createLsToolDefinition(cwd, { operations: ops.ls }),
      createFindToolDefinition(cwd, { operations: ops.find }),
      createGrepToolDefinition(cwd, { operations: ops.grep }),
      // Pi's per-tool generics are invariant in renderCall; the array type is the SDK's erased form.
    ] as unknown as ToolDefinition[],
  });

  const active = session.getActiveToolNames();
  const illegal = active.filter((n) => !(ALLOWED_TOOLS as readonly string[]).includes(n));
  if (illegal.length > 0) {
    throw new Error(`Refusing to start: unexpected tools enabled: ${illegal.join(", ")}`);
  }
  return { session, sandbox };
}
