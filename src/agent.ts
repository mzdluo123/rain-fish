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
import { createRunPythonTool, RUN_PYTHON_TOOL } from "./tools/run-python.js";
import { canReadImages } from "./context/archive.js";
import { createVfsFindTool, createVfsGrepTool } from "./tools/vfs-search.js";
import type { AgentDeps } from "./types.js";
import { assertSeen } from "./context/read-guard.js";
import { createVfsOperations } from "./vfs-ops.js";

/** The only tools the agent may ever use. `bash` is deliberately absent; `run_python` runs code on Colab, never on this host, and exists only if configured. */
export const ALLOWED_TOOLS = ["read", "write", "edit", "ls", "find", "grep", SEARCH_TOOL, VIEW_IMAGE_TOOL, SEND_TOOL, SEND_IMAGE_TOOL, STOP_TOOL, RUN_PYTHON_TOOL] as const;

/** The agent's working directory is the root of its virtual filesystem. */
const VFS_ROOT = "/";

const WRITE_TOOL = "write";
const EDIT_TOOL = "edit";
/** Tools that cannot meaningfully fail, so they must not run in a batch with a `write`. */
const GUARDED_TOOLS: ReadonlySet<string> = new Set([SEND_TOOL, SEND_IMAGE_TOOL, STOP_TOOL]);
const GUARD_BLOCKERS: ReadonlySet<string> = new Set([WRITE_TOOL]);
/** `run_python` reads a file: in a batch that also writes or edits one, it could run the old text. */
const RUN_BLOCKERS: ReadonlySet<string> = new Set([WRITE_TOOL, EDIT_TOOL]);

export async function createAgent({ systemPrompt, fs, store, groupId, send, sendImage, images, budget, modelImage, python, model, modelRuntime, thinkingLevel }: AgentDeps): Promise<{ session: AgentSession }> {
  let current: AgentSession | undefined; // set right after the session exists; the tools below use it lazily
  // An edit, or a write over an existing file, needs the file's current text in the context window: the guard looks at the session's own messages.
  const ops = createVfsOperations(fs, { requireSeen: (p) => assertSeen(fs, current?.agent.state.messages ?? [], p) });

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

  const allowed: string[] = ALLOWED_TOOLS.filter((n) => n !== RUN_PYTHON_TOOL || python !== undefined);
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
      ...(python ? [createRunPythonTool(fs, python)] : []),
      // Pi's per-tool generics are invariant in renderCall; the array type is the SDK's erased form.
    ] as unknown as ToolDefinition[],
  });

  current = session;

  // `write` can fail; `send`/`send_image`/`stop` practically cannot. If they ran in the same batch, a failed write would still
  // have posted a message or ended the run. So when the batch contains a `write`, the others are blocked (they come back as
  // errors and the agent repeats them in the next step, after seeing the write's result). Blocking happens before execution:
  // an already-sent message cannot be taken back. `run_python` is held back the same way by a `write` or an `edit`.
  const previousBefore = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    const base = await previousBefore?.(context, signal);
    const name = context.toolCall.name;
    if (base?.block || (!GUARDED_TOOLS.has(name) && name !== RUN_PYTHON_TOOL)) return base;
    const blockers = name === RUN_PYTHON_TOOL ? RUN_BLOCKERS : GUARD_BLOCKERS;
    const blocker = context.assistantMessage.content.find((c) => c.type === "toolCall" && blockers.has(c.name));
    return blocker?.type === "toolCall"
      ? { block: true, reason: `Not executed: this step also calls \`${blocker.name}\`, which may fail. Call \`${name}\` again in a later step, after the \`${blocker.name}\` result is known.` }
      : base;
  };

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
