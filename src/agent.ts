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
} from "@earendil-works/pi-coding-agent";
import { createSearchMessagesTool, SEARCH_TOOL } from "./tools/search-messages.js";
import { createSendImageTool, createSendTool, SEND_IMAGE_TOOL, SEND_TOOL } from "./tools/send.js";
import { createStopTool, STOP_TOOL } from "./tools/stop.js";
import { createViewImageTool, VIEW_IMAGE_TOOL } from "./tools/view-image.js";
import { canReadImages } from "./context/archive.js";
import { createVfsFindTool, createVfsGrepTool } from "./tools/vfs-search.js";
import type { AgentDeps } from "./types.js";
import { assertSeenBeforeEdit } from "./context/read-guard.js";
import { createVfsOperations } from "./vfs-ops.js";

/** The only tools the agent may ever use. `bash` is deliberately absent. */
export const ALLOWED_TOOLS = ["read", "write", "edit", "ls", "find", "grep", SEARCH_TOOL, VIEW_IMAGE_TOOL, SEND_TOOL, SEND_IMAGE_TOOL, STOP_TOOL] as const;

/** The agent's working directory is the root of its virtual filesystem. */
const VFS_ROOT = "/";

export async function createAgent({ systemPrompt, fs, store, groupId, send, sendImage, images, budget, modelImage, model, modelRuntime, thinkingLevel }: AgentDeps): Promise<{ session: AgentSession }> {
  let current: AgentSession | undefined; // set right after the session exists; the tools below use it lazily
  // An edit needs the file's current text in the context window: the guard looks at the session's own messages.
  const ops = createVfsOperations(fs, { beforeEdit: (p) => assertSeenBeforeEdit(fs, current?.agent.state.messages ?? [], p) });

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

  // Context is managed by PiConversation (snap compaction); Pi's own LLM-summary compaction must not also run.
  const settingsManager = SettingsManager.create(VFS_ROOT, getAgentDir());
  settingsManager.applyOverrides({ compaction: { enabled: false } });

  const allowed: string[] = [...ALLOWED_TOOLS];
  const { session } = await createAgentSession({
    cwd: VFS_ROOT,
    resourceLoader,
    settingsManager,
    ...(model ? { model } : {}), // omitted: Pi picks its configured default
    ...(modelRuntime ? { modelRuntime } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}), // omitted: Pi's default
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
      createSearchMessagesTool(store, groupId, images),
      createViewImageTool(images, groupId, () => canReadImages(current?.model), modelImage),
      createSendTool(send, budget),
      createSendImageTool(sendImage, budget),
      createStopTool(),
      // Pi's per-tool generics are invariant in renderCall; the array type is the SDK's erased form.
    ] as unknown as ToolDefinition[],
  });

  current = session;

  // The agent loop ends only if EVERY tool result of a batch asks for it. When `stop` is called together with other tools
  // (`[send, send, stop]`), those must not keep the loop alive: they end with it, unless one failed (then the agent
  // is called again and can retry).
  const previous = session.agent.afterToolCall;
  session.agent.afterToolCall = async (context, signal) => {
    const base = await previous?.(context, signal);
    const failed = base?.isError ?? context.isError;
    if (failed || base?.terminate !== undefined) return base;
    const stops = context.assistantMessage.content.some((c) => c.type === "toolCall" && c.name === STOP_TOOL);
    return stops ? { ...base, terminate: true } : base;
  };

  const illegal = session.getActiveToolNames().filter((n) => !allowed.includes(n));
  if (illegal.length > 0) {
    throw new Error(`Refusing to start: unexpected tools enabled: ${illegal.join(", ")}`);
  }
  return { session };
}
