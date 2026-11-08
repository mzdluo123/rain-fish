/**
 * The single home of every shared type in the program.
 * Wire types are derived from the Zod schemas (the schemas are the source of truth for
 * anything that crosses the WebSocket); everything else is declared here directly.
 */
import type { Database } from "bun:sqlite";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type {
  EditOperations,
  ModelRegistry,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@mariozechner/pi-coding-agent";
import type { z } from "zod";
import type {
  apiResponseSchema,
  groupMessageEventSchema,
  outboundSegmentSchema,
  segmentSchema,
} from "./qq/schemas.js";
import type { configSchema } from "./config.js";
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
  /** Registry the model came from (credentials lookup); omit to let Pi build its default. */
  modelRegistry?: ModelRegistry;
  /** The agent's whole filesystem (in the same SQLite file as everything else). */
  fs: VirtualFs;
  /** Read-only search of this group's history is exposed to the agent as `search_messages`. */
  store: MessageStore;
  /** The one group this agent serves; the agent never sees or names it. */
  groupId: string;
  /** Posts to this conversation's group; backs the agent's `send` tool. `replyTo` is a message id to quote. Rejects if delivery fails. */
  send: SendFn;
}

// ---- QQ wire types (validated at the WebSocket edge, derived from schemas) --------

export type Segment = z.output<typeof segmentSchema>;
export type OutboundSegment = z.input<typeof outboundSegmentSchema>;
export type GroupMessageEvent = z.output<typeof groupMessageEventSchema>;
export type ApiResponse = z.output<typeof apiResponseSchema>;
export type Config = z.output<typeof configSchema>;

/** Result of validating one raw WebSocket frame. Only `group_message` carries chat content. */
export type Frame =
  | { kind: "group_message"; event: GroupMessageEvent }
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

/**
 * Receives the messages the agent should eventually see. It does not answer: the agent speaks
 * through its `send` tool, whenever the responder wakes it.
 */
export interface GroupResponder {
  /** Queue `msg` for the group's next wake-up. `addressed`: it @-mentions the bot or replies to one of its messages. */
  notify(msg: GroupMessage, addressed: boolean): void;
}

export type WakeConfig = Config["wake"];

export interface BotOptions {
  store: MessageStore;
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
   * `run` correlates the turn's events with the responder's. Throws if the model call fails.
   */
  ask(prompt: string, ctx?: { run?: string }): Promise<string>;
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
