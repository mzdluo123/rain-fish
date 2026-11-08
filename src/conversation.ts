import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { buildArchiveMessage, extendArchiveSource, serializeForArchive, type ArchiveBudget } from "./context/archive.js";
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens } from "./context/estimate.js";
import { MEMORY_FLUSH_PROMPT } from "./context/memory.js";
import { SEND_NUDGE_PROMPT } from "./context/nudge.js";
import { pruneExpensive, type PruneState } from "./context/prune.js";
import type { ConversationStore } from "./conversation-store.js";
import { noopLogger } from "./logger.js";
import { SEND_TOOL } from "./tools/send.js";
import { noopEventLog, preview } from "./trace/event-log.js";
import { traceSession } from "./trace/session-events.js";
import type { ContextConfig, Conversation, EventLog, Logger } from "./types.js";

export interface PiConversationDeps {
  groupId: string;
  session: AgentSession;
  store: ConversationStore;
  context: ContextConfig;
  logger?: Logger;
  events?: EventLog;
}

/**
 * One persistent agent conversation with two-level context management:
 *  1. every model call sees a pruned view in which expensive blocks of old messages are cleared;
 *  2. when the context still grows past the threshold, older history is snap-compacted into an archive.
 * Everything is persisted in SQLite, so a restart resumes the same (compacted) conversation.
 */
export class PiConversation implements Conversation {
  /** seq of each live message in `state.messages` (the archive message, if present, has none). */
  private seqs: number[] = [];
  /** The memory flush already ran in this compaction cycle (reset when history is compacted). */
  private flushed = false;
  private archived = false;
  private archiveSource = "";
  private readonly log: Logger;
  private readonly events: EventLog;
  /** Ids of the run (from the responder) and turn in progress, stamped on every event emitted meanwhile. */
  private cur: { run?: string; turn?: string; kind?: string } = {};
  private turnCount = 0;
  /** How far level-1 clearing has gone in the live transcript (see `PruneState`). */
  private readonly pruneState: PruneState = { through: 0 };

  private constructor(private readonly d: PiConversationDeps) {
    this.log = (d.logger ?? noopLogger).withTag("context");
    this.events = (d.events ?? noopEventLog).child({ group: d.groupId });
  }

  static async create(deps: PiConversationDeps): Promise<PiConversation> {
    const c = new PiConversation(deps);
    await c.restore();
    c.installPruning();
    traceSession(deps.session, c.events, () => c.cur);
    c.emit("conv.restore", { messages: c.seqs.length, archived: c.archived, flushed: c.flushed });
    return c;
  }

  /** The underlying session, e.g. to subscribe to streaming events. */
  get session(): AgentSession {
    return this.d.session;
  }

  async ask(prompt: string, ctx: { run?: string; addressed?: boolean } = {}): Promise<string> {
    this.cur = { run: ctx.run };
    try {
      await this.flushMemoryIfNeeded(prompt);
      await this.compactIfNeeded(prompt);
      const first = await this.runTurn(prompt, "message");
      if (!ctx.addressed || first.sent) return first.text;
      // Someone addressed the agent, it wrote text instead of calling `send`: nobody saw it. One reminder turn; a failure of
      // that extra turn is not fatal (the first turn is already persisted and was a valid run).
      this.log.warn(`group ${this.d.groupId}: addressed but the agent did not call send; reminding it once`);
      this.emit("turn.nudge", { reason: "addressed without send", dropped_chars: first.text.length });
      try {
        return (await this.runTurn(SEND_NUDGE_PROMPT, "nudge")).text;
      } catch (err) {
        this.log.warn(`group ${this.d.groupId}: reminder turn failed: ${err instanceof Error ? err.message : String(err)}`);
        return first.text;
      }
    } finally {
      this.cur = {};
    }
  }

  /** Trace event tagged with the group and, while a run is in progress, its `run` and current `turn`. */
  private emit(event: string, data: Record<string, unknown> = {}): void {
    this.events.emit(event, { ...this.cur, ...data });
  }

  /** One model turn: the prompt, the agent's whole tool loop, then persistence. A failed turn leaves no trace. */
  private async runTurn(prompt: string, kind: "message" | "flush" | "nudge"): Promise<{ text: string; sent: boolean }> {
    const state = this.d.session.agent.state;
    const from = state.messages.length;
    this.cur = { ...this.cur, turn: `t${++this.turnCount}`, kind };
    const t0 = Date.now();
    this.emit("turn.start", { prompt_chars: prompt.length, context_messages: from, context_tokens: this.contextTokens(prompt), prompt: preview(this.events, prompt) });
    let added: AgentMessage[];
    try {
      await this.d.session.prompt(prompt);
      added = state.messages.slice(from);
    } catch (err) {
      this.setTranscript(state.messages.slice(0, from), { resetPruning: false });
      this.emit("turn.rollback", { ms: Date.now() - t0, reason: "model call threw", error: err });
      throw err;
    }
    const last = added.findLast((m) => m.role === "assistant");
    if (!last || last.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
      // A failed turn leaves no trace: not in memory, not in the database.
      this.setTranscript(state.messages.slice(0, from), { resetPruning: false });
      const reason = last?.role === "assistant" ? (last.errorMessage ?? `model call ${last.stopReason}`) : "no reply from the model";
      this.emit("turn.rollback", { ms: Date.now() - t0, reason: last?.role === "assistant" ? last.stopReason : "no assistant message", error: reason, discarded_messages: added.length });
      throw new Error(reason);
    }
    this.seqs.push(...this.d.store.append(this.d.groupId, added));
    const text = last.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
    const assistants = added.filter((m) => m.role === "assistant");
    this.emit("turn.end", {
      ms: Date.now() - t0,
      stop_reason: last.stopReason,
      added_messages: added.length,
      llm_calls: assistants.length,
      tool_calls: added.filter((m) => m.role === "toolResult").length,
      final_chars: text.length,
      persisted_through_seq: this.seqs.at(-1),
    });
    const sent = added.some((m) => m.role === "toolResult" && m.toolName === SEND_TOOL && !m.isError);
    return { text, sent };
  }

  /**
   * Replaces the live transcript. Pi 1.x rebuilds `agent.state.messages` from its SessionManager before every request, so
   * assigning to `state.messages` alone is silently undone (the model would see none of the history, or a rolled-back turn).
   * The SessionManager is in-memory; our own persistence is the database.
   */
  private setTranscript(messages: AgentMessage[], opts: { resetPruning: boolean }): void {
    const { session } = this.d;
    if (opts.resetPruning) this.pruneState.through = 0; // indices shift (restore, compaction); a rollback only truncates, so the watermark stays valid
    session.sessionManager.newSession();
    for (const m of messages) session.sessionManager.appendMessage(m as never);
    session.agent.state.messages = session.sessionManager.buildSessionProjection().messages;
  }

  private get budget(): ArchiveBudget {
    return { model: this.d.session.model, archiveTokens: this.d.context.archiveTokens };
  }

  private async restore(): Promise<void> {
    // Stored `system` messages carry the prompt sections and tool declarations. Replaying them keeps the request byte-identical
    // to the one before the restart (without them Pi re-declares the tools in another shape and the whole prompt cache misses).
    const { archive, messages } = this.d.store.load(this.d.groupId);
    const restored: AgentMessage[] = [];
    if (archive) {
      this.archiveSource = archive.sourceText;
      this.archived = true;
      restored.push(await buildArchiveMessage(archive.sourceText, this.budget));
    }
    restored.push(...messages.map((m) => m.message));
    this.seqs = messages.map((m) => m.seq);
    this.flushed = this.d.store.loadFlushed(this.d.groupId);
    if (restored.length > 0) {
      this.setTranscript(restored, { resetPruning: true });
      this.log.info(`group ${this.d.groupId}: restored ${messages.length} message(s)${archive ? " + archive" : ""}`);
    }
  }

  /** Level 1: applied to the view sent to the model, so the stored history stays complete. */
  private installPruning(): void {
    const agent = this.d.session.agent;
    const previous = agent.transformContext;
    agent.transformContext = async (messages, signal) =>
      pruneExpensive(previous ? await previous(messages, signal) : messages, this.pruneOptions, this.pruneState);
  }

  /**
   * Just before compaction would retire older history, give the agent one turn to write what matters
   * into its files (without `send`: this turn must not speak in the group). Runs once per cycle.
   * A failed flush is logged and not fatal: the context must still be bounded.
   */
  private async flushMemoryIfNeeded(prompt: string): Promise<void> {
    const { session, context: c, groupId } = this.d;
    if (this.flushed) return;
    const tokens = this.contextTokens(prompt);
    const threshold = c.compactTokens * c.flushRatio;
    if (tokens <= threshold) return;

    this.log.info(`group ${groupId}: context ~${tokens} tokens, nearing compaction at ${c.compactTokens}; asking the agent to save memory`);
    this.emit("flush.start", { tokens, threshold, compact_at: c.compactTokens });
    this.emit("conv.state", { from: "fresh", to: "flushing", reason: "context near compaction" });
    const t0 = Date.now();
    const tools = session.getActiveToolNames();
    session.setActiveToolsByName(tools.filter((n) => n !== SEND_TOOL));
    try {
      await this.runTurn(MEMORY_FLUSH_PROMPT, "flush");
      this.flushed = true;
      this.d.store.setFlushed(groupId);
      this.log.success(`group ${groupId}: memory flush done`);
      this.emit("flush.ok", { ms: Date.now() - t0 });
      this.emit("conv.state", { from: "flushing", to: "flushed", reason: "flush turn done" });
    } catch (err) {
      this.log.warn(`group ${groupId}: memory flush failed, continuing: ${err instanceof Error ? err.message : String(err)}`);
      this.emit("flush.fail", { ms: Date.now() - t0, error: err });
      this.emit("conv.state", { from: "flushing", to: "fresh", reason: "flush failed, retried on the next message" });
    } finally {
      session.setActiveToolsByName(tools);
      this.cur = { run: this.cur.run }; // the flush turn is over: later events (compaction, the real turn) are not part of it
    }
  }

  private contextTokens(prompt: string): number {
    const { session } = this.d;
    const view = pruneExpensive(session.agent.state.messages, this.pruneOptions, this.pruneState, false);
    return estimateContextTokens(session.systemPrompt, view) + estimateTextTokens(prompt);
  }

  /** Size of the context the next request would carry (the estimate the compaction thresholds use). */
  estimateContext(): number {
    return this.contextTokens("");
  }

  private get pruneOptions() {
    const { recentTokens, pruneMinTokens, pruneBatchBlocks } = this.d.context;
    return { recentTokens, minBlockTokens: pruneMinTokens, batchBlocks: pruneBatchBlocks };
  }

  /** Level 2: snap-compact older history once the (pruned) context passes the threshold. */
  private async compactIfNeeded(prompt: string): Promise<void> {
    const { session, context: c, groupId } = this.d;
    const state = session.agent.state;
    const tokens = this.contextTokens(prompt);
    if (tokens <= c.compactTokens) return;

    const offset = this.archived ? 1 : 0;
    const messages = state.messages;
    const cut = this.findCut(messages, offset);
    if (cut <= offset) {
      this.log.warn(`group ${groupId}: context ~${tokens} tokens but no complete turn is older than the recent window; not compacting`);
      this.emit("compact.skip", { tokens, threshold: c.compactTokens, reason: "no complete turn older than the recent window" });
      return;
    }
    const t0 = Date.now();
    const source = extendArchiveSource(this.archiveSource, serializeForArchive(messages.slice(offset, cut)), this.budget);
    const archive = await buildArchiveMessage(source, this.budget);

    const throughSeq = this.seqs[cut - offset - 1]!;
    this.setTranscript([archive, ...messages.slice(cut)], { resetPruning: true });
    this.seqs = this.seqs.slice(cut - offset);
    this.archiveSource = source;
    this.archived = true;
    const wasFlushed = this.flushed;
    this.flushed = false;
    this.d.store.archive(groupId, throughSeq, source);
    const after = estimateContextTokens(session.systemPrompt, state.messages);
    this.log.success(`group ${groupId}: compacted ${cut - offset} message(s) into the archive (~${tokens} -> ~${after} tokens)`);
    this.emit("compact.done", { archived_messages: cut - offset, kept_messages: messages.length - cut, tokens_before: tokens, tokens_after: after, archive_chars: source.length, through_seq: throughSeq, ms: Date.now() - t0 });
    this.emit("conv.state", { from: wasFlushed ? "flushed" : "fresh", to: "fresh", reason: "compaction" });
  }

  /**
   * Index of the first message kept verbatim: the oldest turn start (user message) such that everything
   * from there on fits the recent window. Messages [offset, cut) get archived. Cutting only at turn
   * starts keeps every tool call together with its result.
   */
  private findCut(messages: readonly AgentMessage[], offset: number): number {
    let acc = 0;
    let first = messages.length; // oldest index inside the recent window
    while (first > offset) {
      acc += estimateMessageTokens(messages[first - 1]!);
      if (acc > this.d.context.recentTokens) break;
      first--;
    }
    for (let i = Math.max(first, offset + 1); i < messages.length; i++) {
      if (messages[i]!.role === "user") return i;
    }
    return offset;
  }
}
