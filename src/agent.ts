import {
  createAgentSession,
  createEditToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { createSearchMessagesTool, SEARCH_TOOL } from "./tools/search-messages.js";
import { createVfsFindTool, createVfsGrepTool } from "./tools/vfs-search.js";
import type { AgentDeps } from "./types.js";
import { createVfsOperations } from "./vfs-ops.js";

/** The only tools the agent may ever use. `bash` is deliberately absent. */
export const ALLOWED_TOOLS = ["read", "write", "edit", "ls", "find", "grep", SEARCH_TOOL] as const;

/** The agent's working directory is the root of its virtual filesystem. */
const VFS_ROOT = "/";

export async function createAgent({ systemPrompt, fs, store, model, modelRegistry }: AgentDeps): Promise<{ session: AgentSession }> {
  const ops = createVfsOperations(fs);

  // Disable everything that could smuggle in extra tools or instructions
  // (extensions can register bash-like tools; skills/context files come from the host disk).
  const resourceLoader = new DefaultResourceLoader({
    cwd: VFS_ROOT,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt, // pass the text itself: Pi would read a string that happens to be an existing path as a file
  });
  await resourceLoader.reload();

  // Context is managed by PiConversation (prune + snap-compact); Pi's own LLM-summary compaction must not also run.
  const settingsManager = SettingsManager.create(VFS_ROOT, getAgentDir());
  settingsManager.applyOverrides({ compaction: { enabled: false } });

  const allowed: string[] = [...ALLOWED_TOOLS];
  const { session } = await createAgentSession({
    cwd: VFS_ROOT,
    resourceLoader,
    settingsManager,
    ...(model ? { model } : {}), // omitted: Pi picks its configured default
    ...(modelRegistry ? { modelRegistry } : {}),
    sessionManager: SessionManager.inMemory(VFS_ROOT),
    // Allowlist: built-in `bash` is never enabled.
    tools: allowed,
    // Same-named custom definitions replace the host-disk built-ins with database-backed ones.
    customTools: [
      createReadToolDefinition(VFS_ROOT, { operations: ops.read }),
      createWriteToolDefinition(VFS_ROOT, { operations: ops.write }),
      createEditToolDefinition(VFS_ROOT, { operations: ops.edit }),
      createLsToolDefinition(VFS_ROOT, { operations: ops.ls }),
      createVfsFindTool(fs),
      createVfsGrepTool(fs),
      createSearchMessagesTool(store),
      // Pi's per-tool generics are invariant in renderCall; the array type is the SDK's erased form.
    ] as unknown as ToolDefinition[],
  });

  const illegal = session.getActiveToolNames().filter((n) => !allowed.includes(n));
  if (illegal.length > 0) {
    throw new Error(`Refusing to start: unexpected tools enabled: ${illegal.join(", ")}`);
  }
  return { session };
}
