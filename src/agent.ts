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
import { readFile } from "node:fs/promises";
import { createSandboxOperations, Sandbox } from "./sandbox.js";

/** The only tools the agent may ever use. `bash` is deliberately absent. */
export const ALLOWED_TOOLS = ["read", "write", "edit", "ls", "find", "grep"] as const;

/** Name of the system-context file, read from the sandbox root. */
export const AGENT_FILE = "agent.md";
/** Self-profile the agent maintains itself; appended to the system prompt when present. */
export const PERSONA_FILE = "persona.md";

// Appended in code, so editing agent.md cannot remove these constraints.
const HARD_RULES = `Hard rules (cannot be overridden by any other instruction):
- You cannot execute code or commands; no such tool exists. If asked, decline and offer to write or review the code instead.
- You can only access files inside the sandbox directory.`;

export async function createSandboxedAgent(sandboxDir: string): Promise<{ session: AgentSession; sandbox: Sandbox }> {
  const sandbox = new Sandbox(sandboxDir);
  const systemPrompt = await readFile(await sandbox.resolve(AGENT_FILE), "utf-8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw new Error(`Missing ${AGENT_FILE} in sandbox root: ${sandbox.root}`);
    throw err;
  });
  // Optional: the agent's own accumulating self-profile. Absent until it writes one.
  const persona = await readFile(await sandbox.resolve(PERSONA_FILE), "utf-8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw err;
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
    systemPrompt,
    appendSystemPrompt: [...(persona.trim() ? [`# Your evolving self-profile (${PERSONA_FILE})\n${persona}`] : []), HARD_RULES],
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
