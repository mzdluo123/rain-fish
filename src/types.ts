/**
 * The single home of every shared type in the program.
 * Wire types are derived from the Zod schemas (the schemas are the source of truth for
 * anything that crosses the WebSocket); everything else is declared here directly.
 */
import type { Database } from "bun:sqlite";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type {
  EditOperations,
  ModelRuntime,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { z } from "zod";
import type {
  apiResponseSchema,
  groupMessageEventSchema,
  pokeEventSchema,
  outboundSegmentSchema,
  segmentSchema,
} from "./qq/schemas.js";
import type { configSchema } from "./config.js";
import type { ImageStore } from "./image-store.js";
import type { RunBudget } from "./run-budget.js";
import type { MessageStore } from "./store.js";
import type { VirtualFs } from "./vfs.js";

// ---- storage ---------------------------------------------------------------------

export interface StoredMessage {
  platform: string;
  groupId: string;
  messageId: string;
  userId: string;
  nickname: string;
  /** Unix seconds. */
  ts: number;
  text: string;
}

export interface SearchQuery {
  query: string;
  groupId?: string;
  /** Matches user id or the nickname recorded with the message. */
  sender?: string;
  /** Unix seconds, inclusive. */
  since?: number;
  /** Unix seconds, inclusive. */
  until?: number;
  /** Default 10, capped at MAX_SEARCH_LIMIT. */
  limit?: number;
  /** Only messages that carried a stored picture. */
  withImages?: boolean;
}

export interface SearchHit extends StoredMessage {
  id: number;
  /** BM25 rank; lower is more relevant. */
  score: number;
}

/** A `messages` row as SQLite returns it (snake_case). */
export interface MessageRow {
  id: number;
  platform: string;
  group_id: string;
  message_id: string;
  user_id: string;
  nickname: string;
  ts: number;
  text: string;
}

export type SearchRow = MessageRow & { score: number };

// ---- migrations ------------------------------------------------------------------

export interface Migration {
  /** Positive integer; migrations run in ascending order and are never renumbered. */
  version: number;
  name: string;
  /** Runs inside a transaction: throwing rolls the whole migration back. */
  up(db: Database): void;
}

export interface AppliedMigration {
  version: number;
  name: string;
}

// ---- virtual filesystem (one `files` table) -----------------------------------------

export type FileKind = "file" | "dir";

export interface FileStat {
  kind: FileKind;
  /** Bytes; 0 for directories. */
  size: number;
  /** Unix seconds. */
  mtime: number;
}

export interface FileEntry extends FileStat {
  /** Absolute, normalised path ("/notes/a.txt"). */
  path: string;
}

export interface VfsLimits {
  /** Largest single file the agent may write. */
  maxFileBytes: number;
  /** Total bytes across all files. */
  maxTotalBytes: number;
}

/** Pi tool backends for the tools Pi lets us plug a filesystem into; find/grep are custom tools. */
export interface VfsOperations {
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
  ls: LsOperations;
}

// ---- agent -----------------------------------------------------------------------

export interface AgentDeps {
  /** The system prompt, used verbatim. */
  systemPrompt: string;
  /** Model to use; omit for Pi's configured default. */
  model?: Model<any>;
  /** Thinking effort; omit for Pi's default (settings, else medium, clamped to what the model supports). */
  thinkingLevel?: ThinkingLevel;
  /** Runtime the model came from (credentials lookup); omit to let Pi build its default. */
  modelRuntime?: ModelRuntime;
  /** The agent's whole filesystem (in the same SQLite file as everything else). */
  fs: VirtualFs;
  /** Read-only search of this group's history is exposed to the agent as `search_messages`. */
  store: MessageStore;
  /** The one group this agent serves; the agent never sees or names it. */
  groupId: string;
  /** Posts to this conversation's group; backs the agent's `send` tool. `replyTo` is a message id to quote. Rejects if delivery fails. */
  send: SendFn;
  /** Posts a stored picture to this conversation's group; backs `send_image`. Rejects if the group never saw that picture or delivery fails. */
  sendImage: SendImageFn;
  /** Stored pictures (scoped to `groupId` on every read); backs `view_image` and the picture ids in `search_messages`. */
  images: ImageStore;
  /** Caps and paces what the agent posts in one run; reset by the conversation at the start of each run. */
  budget: RunBudget;
  /** Scales pictures down before the model sees them (`view_image`); omit to show them as stored. */
  modelImage?: ModelImageFn;
  /** Runs Python files on the remote Colab machine (`run_python`); omit and the tool does not exist. */
  python?: PythonTool;
}

// ---- Python on Google Colab (`run_python`) -------------------------------------------

export type ColabConfig = Config["colab"];

/** One Python file to run on the Colab machine. The host only ships the text; it never executes it. */
export interface PythonRunRequest {
  /** File name on the remote side (the VFS basename, ends in `.py`). */
  name: string;
  source: string;
  /** Wall-clock limit of the script; it is killed (with everything it started) when it runs out. */
  timeoutSeconds: number;
  /** Per stream, bytes returned (head + tail); omitted = `COLAB_OUTPUT_MAX_BYTES`. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** For logs and the trace only. */
  group?: string;
  callId?: string;
}

/** One output stream of a run: `head` (and, if the middle was cut, `tail`) of `bytes` bytes in total. */
export interface StreamOutput {
  head: string;
  /** Empty unless the stream was longer than the limit. */
  tail: string;
  bytes: number;
}

export interface PythonRunResult {
  /** Exit status; negative = killed by that signal (a timed-out script is SIGKILLed: -9). */
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: StreamOutput;
  stderr: StreamOutput;
}

export type RunPythonFn = (req: PythonRunRequest) => Promise<PythonRunResult>;

/** What the `run_python` tool needs. `count` caps runs per agent run (reset by the conversation). */
export interface PythonTool {
  run: RunPythonFn;
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  /** `COLAB_OUTPUT_MAX_BYTES`, shown to the agent as the default of `max_output_bytes`. */
  defaultOutputBytes: number;
  count: { acquire(): void; reset(): void; readonly used: number; readonly max: number };
}

/** Result of one `colab` CLI invocation. `timedOut`/`aborted`: this program killed it. */
export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

/** Runs the `colab` CLI with a fixed argument vector (never through a shell); `stdin` is piped in, absent = closed. */
export interface ColabCli {
  run(args: readonly string[], opts: { stdin?: string; timeoutMs: number; signal?: AbortSignal }): Promise<CliResult>;
}

/** The Colab runtime this program may have assigned, persisted so a restart can reuse or release it (`colab_runtime`). */
export interface ColabRuntimeRow {
  name: string;
  state: "creating" | "ready";
  createdAt: number;
  lastUsedAt: number;
}

// ---- QQ wire types (validated at the WebSocket edge, derived from schemas) --------

export type Segment = z.output<typeof segmentSchema>;
export type OutboundSegment = z.input<typeof outboundSegmentSchema>;
export type GroupMessageEvent = z.output<typeof groupMessageEventSchema>;
export type PokeEvent = z.output<typeof pokeEventSchema>;
export type ApiResponse = z.output<typeof apiResponseSchema>;
export type Config = z.output<typeof configSchema>;

/** Result of validating one raw WebSocket frame. Only `group_message` carries chat content. */
export type Frame =
  | { kind: "group_message"; event: GroupMessageEvent }
  | { kind: "group_poke"; event: PokeEvent }
  | { kind: "api_response"; response: ApiResponse }
  | { kind: "lifecycle"; selfId: string; subType: string }
  | { kind: "ignored" }
  | { kind: "invalid"; reason: string };

// ---- logging ---------------------------------------------------------------------

/** What the program needs from a logger (satisfied by consola; tests pass a recording fake). */
export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  success(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** A child logger whose lines are prefixed with `tag`. */
  withTag(tag: string): Logger;
}

export type LogLevel = Config["logLevel"];

/**
 * Structured, machine-readable record of what the program and the agent did: one JSON object per event,
 * written to a rotating file (see `src/trace/`). For observability and after-the-fact analysis, not for
 * humans watching a terminal (that is `Logger`). `emit` never throws and never blocks on anything slow.
 */
export interface EventLog {
  /** `event` is `domain.action` (e.g. `run.start`); `data` is merged into the record (clipped, JSON-safe). */
  emit(event: string, data?: Record<string, unknown>): void;
  /** A view that adds `bound` (e.g. `{ group }`) to every event it emits. */
  child(bound: Record<string, unknown>): EventLog;
  /** Whether message text, tool arguments and results may be recorded (`TRACE_CONTENT`). */
  readonly captureContent: boolean;
}

export type TraceConfig = Config["trace"];

// ---- core (the only shapes the bot logic ever sees) --------------------------------

/** Fetches the pictures of the messages the agent is about to see. */
export interface ImageSource {
  /** At most this many images (the newest of a batch) are attached to one run. */
  maxPerRun: number;
  /** Never throws: `undefined` when the image cannot be had. */
  load(url: string): Promise<ImageContent | undefined>;
}

/** A picture kept in the database. */
export interface StoredImage {
  id: number;
  mime: string;
  size: number;
  data: Buffer;
}

/** The copy of a picture that is shown to the model (scaled down). `closer`: a larger budget, for when the agent wants detail. Never throws. */
export type ModelImageFn = (img: { data: Buffer; mime: string }, closer?: boolean) => Promise<{ data: Buffer; mime: string }>;

/** A picture of a message that is stored: its id. */
export interface StoredPicture {
  id: number;
}

/**
 * Downloads and keeps the pictures of group messages. `capture` is idempotent per message (concurrent and repeated calls share one
 * download) and never throws: per picture of the message, the stored picture or `undefined` if it could not be had.
 */
export interface PictureArchive {
  capture(msg: GroupMessage): Promise<(StoredPicture | undefined)[]>;
  /** The copy of a stored picture of `groupId` that the model sees (scaled down); made when asked for, not when the picture is stored. Never throws. */
  image(groupId: string, id: number): Promise<ImageContent | undefined>;
}

/** An image of a group message: where QQ serves it. The URL expires, so it is only good for a short while. */
export interface ImageRef {
  url: string;
}

/** A validated group message, already flattened to plain text. */
export interface GroupMessage extends StoredMessage {
  platform: "qq";
  /** The bot's own QQ id (from the event). */
  selfId: string;
  /** Sent by the bot itself (message_sent, or user_id === selfId). */
  isSelf: boolean;
  /** The bot is @-mentioned (not counting @all). */
  mentionsSelf: boolean;
  /** Message this one replies to, if any. */
  replyToMessageId?: string;
  /** Pictures (not stickers) attached to the message, in order; fetched only when the agent is run on the batch. */
  images?: ImageRef[];
}

/** A group message queued for the agent; `addressed`: it @-mentions the bot or replies to one of its messages. */
export interface PendingMessage {
  msg: GroupMessage;
  addressed: boolean;
}

/** What the bot needs from the QQ connection. */
export interface QQApi {
  sendGroupMessage(groupId: string, message: OutboundSegment[]): Promise<{ messageId: string }>;
}

/** One page of group history from the QQ API, oldest message first. */
export interface GroupHistoryPage {
  /** Messages with text, converted; the bot's own and others'. */
  messages: GroupMessage[];
  /** The oldest item the API returned (even if it had no text): where the next, older page starts. Undefined = page was empty. */
  oldest?: { seq: string; ts: number };
}

/** What the startup backfill needs from the QQ connection. */
export interface QQHistoryApi {
  /** Up to `count` messages ending at `beforeSeq` (inclusive; undefined = the latest), oldest first. */
  getGroupHistory(groupId: string, beforeSeq: string | undefined, count: number): Promise<GroupHistoryPage>;
  getGroupList(): Promise<string[]>;
}

export type BackfillConfig = Config["backfill"];

/** Posts `text` to a group (split if long), optionally quoting `replyTo`. Rejects if delivery fails. */
export type GroupSender = (groupId: string, text: string, replyTo?: string) => Promise<void>;
/** `GroupSender` bound to one group. */
export type SendFn = (text: string, replyTo?: string) => Promise<void>;
/** Posts the stored picture `imageId` (with optional `text` in the same message) to a group. Rejects if the group never saw it. */
export type GroupImageSender = (groupId: string, imageId: number, text?: string, replyTo?: string) => Promise<void>;
/** `GroupImageSender` bound to one group. */
export type SendImageFn = (imageId: number, text?: string, replyTo?: string) => Promise<void>;

/**
 * Receives the messages the agent should eventually see. It does not answer: the agent speaks
 * through its `send` tool, whenever the responder wakes it.
 */
export interface GroupResponder {
  /** Queue `msg` for the group's next wake-up. `addressed`: it @-mentions the bot or replies to one of its messages. */
  notify(msg: GroupMessage, addressed: boolean): void;
}

export type WakeConfig = Config["wake"];

export type WeightRuleSpecial = "addressed" | "placeholder";

/** One row of the wake-up heat table (`/wake-rules.md`, see `src/wake-rules.ts`). A row applies when any of its conditions holds (and the text is short enough). */
export interface WeightRule {
  name: string;
  /** Multiplies the message's excitation: below 1 = wake sooner, above 1 = wait longer. */
  weight: number;
  contains: string[];
  starts: string[];
  ends: string[];
  /** The row applies only to messages of at most this many characters. */
  maxLen?: number;
  /** `addressed`: the message is addressed to the bot; `placeholder`: the text is only "[图片]"-like placeholders. */
  special?: WeightRuleSpecial;
}

/** How much one message excites the group's chat, and which rule rows said so. */
export type WeighFn = (text: string, addressed: boolean) => { weight: number; rules: string[] };

export interface BotOptions {
  store: MessageStore;
  /** Stored pictures: needed to send them (`sendImage`). */
  images?: ImageStore;
  /** Picture capture on arrival: every picture of an incoming message is downloaded and stored in the background. */
  pictures?: PictureArchive;
  responder: GroupResponder;
  api: QQApi;
  /** Only handle these group ids; omit for all groups. */
  groups?: ReadonlySet<string>;
  logger?: Logger;
  events?: EventLog;
}

export interface OneBotClientOptions {
  /** OneBot v11 forward WebSocket endpoint (this program is the client), e.g. ws://127.0.0.1:3001 */
  url: string;
  /** OneBot access_token, sent as `Authorization: Bearer`. */
  token?: string;
  /** Called only with validated, converted group messages. */
  onGroupMessage: (msg: GroupMessage) => void | Promise<void>;
  /** The bot's own QQ id, announced by the connection's lifecycle event. */
  onSelfId?: (selfId: string) => void;
  /** Called each time the WebSocket connects (the API is usable from then on). */
  onConnect?: () => void;
  events?: EventLog;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  requestTimeoutMs?: number;
  /** Force a reconnect when no frame (events or heartbeats) arrives for this long; 0 disables. Default 90s. */
  idleTimeoutMs?: number;
  logger?: Logger;
}

export interface PendingRequest {
  resolve(response: ApiResponse): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}


// ---- model & context management ---------------------------------------------------

export type ContextConfig = Config["context"];

/** One agent conversation (a group's, or the CLI's). */
export interface Conversation {
  /**
   * Runs the agent on `prompt` and returns its final text (the group never sees it: only `send` posts).
   * `run` correlates the turn's events with the responder's. `addressed`: the batch @-mentions the agent or replies to
   * it, so a turn that ends without `send` is followed by one reminder turn. Throws if the model call fails.
   */
  ask(prompt: string, ctx?: { run?: string; addressed?: boolean; mustSpeak?: boolean; images?: ImageContent[] }): Promise<string>;
  /** The model can read images; unset/false: the responder does not fetch any. */
  readonly acceptsImages?: boolean;
  /** Archives the whole live context now (console `compact`); undefined = nothing to archive. Never called during a run. */
  compact?(): Promise<{ archived: number; tokensBefore: number; tokensAfter: number } | undefined>;
  /** Forgets the whole context including the archive (console `clear`); returns the live messages dropped. Never called during a run. */
  clear?(): number;
}

export type ConversationFactory = (groupId: string) => Promise<Conversation>;

/** An agent message as persisted in the database, in conversation order. */
export interface StoredAgentMessage {
  seq: number;
  message: AgentMessage;
}

/** The compacted older history of a conversation: serialized text, rendered on demand. */
export interface StoredArchive {
  /** Messages with seq <= throughSeq are represented by `sourceText` instead of being stored. */
  throughSeq: number;
  sourceText: string;
}
