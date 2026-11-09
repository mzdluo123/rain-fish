import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { buildArchiveMessage, canReadImages, extendArchiveSource, serializeForArchive, type ArchiveBudget } from "./context/archive.js";
import { estimateContextTokens, estimateMessageTokens, estimateMessagesTokens, estimateTextTokens } from "./context/estimate.js";
import { imageBlockTokens } from "./context/image-size.js";
import { MEMORY_FLUSH_PROMPT } from "./context/memory.js";
import { linkNotice, linkNudgePrompt, SEND_NUDGE_PROMPT, SPEAK_NUDGE_PROMPT } from "./context/nudge.js";
import { personaPinMessage } from "./context/persona.js";
import type { ConversationStore } from "./conversation-store.js";
import { noopLogger } from "./logger.js";
import { SPEAK_TOOLS } from "./tools/send.js";
import type { RunBudget } from "./run-budget.js";
import { noopEventLog, preview } from "./trace/event-log.js";
import { traceSession } from "./trace/session-events.js";
import type { CacheCompactConfig, ContextConfig, Conversation, EventLog, Logger } from "./types.js";

/** Tokens the pictures of a prompt will cost (measured from their headers). */
const imageTokens = (images?: readonly ImageContent[]): number => (images ?? []).reduce((n, i) => n + imageBlockTokens(i), 0);

export interface PiConversationDeps {
  groupId: string;
  session: AgentSession;
  store: ConversationStore;
  context: ContextConfig;
  /** Compaction after the prompt cache expired; omitted = never. */
  cacheCompact?: CacheCompactConfig;
  /** Clock (ms); replaceable in tests. */
  now?: () => number;
  logger?: Logger;
  events?: EventLog;
  /** Per-run caps (messages posted, Python runs); each is reset at the start of every run and reminder turn. */
  budgets?: readonly Pick<RunBudget, "reset">[];
  /** The agent's self-profile (its `/persona.md`), pinned at the top of every request; undefined = none yet. Read once per run. */
  persona?: () => string | undefined;
  /** Paths of the profile files (entry + linked notes); the archive leaves out what the agent read from and wrote to them. Called when compacting. */
  personaPaths?: () => ReadonlySet<string>;
  /** `.md`/`.py` files that `/persona.md` does not reach by links (empty = the tree is complete). Called at the start of every run and after a run that wrote files. */
  unlinked?: () => string[];
}

/**
 * One persistent agent conversation. The context only ever shrinks by compaction: when it grows past the threshold,
 * older history is snap-compacted into an archive (pictures are already scaled down when they enter, the agent's
 * profile is pinned outside the history). Everything is persisted in SQLite, so a restart resumes the same (compacted) conversation.
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
  /** The persona as of the start of the current run (an edit during the run shows up in the next one: the request prefix stays stable). */
  private pinned?: AgentMessage;

  private constructor(private readonly d: PiConversationDeps) {
    this.log = (d.logger ?? noopLogger).withTag("context");
    this.events = (d.events ?? noopEventLog).child({ group: d.groupId });
  }

  static async create(deps: PiConversationDeps): Promise<PiConversation> {
    const c = new PiConversation(deps);
    c.refreshPersona();
    await c.restore();
    c.installPersonaPin();
    traceSession(deps.session, c.events, () => c.cur);
    c.emit("conv.restore", { messages: c.seqs.length, archived: c.archived, flushed: c.flushed });
    return c;
  }

  /** The underlying session, e.g. to subscribe to streaming events. */
  get session(): AgentSession {
    return this.d.session;
  }

  /** Whether the session's model reads images; the responder only fetches pictures if so. */
  get acceptsImages(): boolean {
    return canReadImages(this.d.session.model);
  }

  async ask(prompt: string, ctx: { run?: string; addressed?: boolean; mustSpeak?: boolean; images?: ImageContent[] } = {}): Promise<string> {
    this.cur = { run: ctx.run };
    this.resetBudgets();
    this.refreshPersona();
    const images = this.acceptsImages ? ctx.images : undefined; // a text-only model would reject the request
    try {
      const unlinked = this.unlinkedNotes();
      if (unlinked.length > 0) {
        prompt = `${prompt}\n\n${linkNotice(unlinked)}`; // appended at the very end of the user turn: the cached prefix is untouched
        this.emit("links.unlinked", { count: unlinked.length, when: "run start" });
      }
      await this.compactIfCacheExpired(prompt, imageTokens(images));
      await this.flushMemoryIfNeeded(prompt, imageTokens(images));
      await this.compactIfNeeded(prompt, imageTokens(images));
      const first = await this.runTurn(prompt, "message", images);
      if (first.wrote) await this.linkReminder();
      if ((!ctx.addressed && !ctx.mustSpeak) || first.sent) return first.text;
      // Someone addressed the agent (or it was told it must speak), it wrote text instead of calling `send`: nobody saw it. One
      // reminder turn; a failure of that extra turn is not fatal (the first turn is already persisted and was a valid run).
      const reason = ctx.addressed ? "addressed without send" : "must speak without send";
      this.log.warn(`group ${this.d.groupId}: ${reason}; reminding it once`);
      this.emit("turn.nudge", { reason, dropped_chars: first.text.length });
      this.resetBudgets();
      try {
        return (await this.runTurn(ctx.addressed ? SEND_NUDGE_PROMPT : SPEAK_NUDGE_PROMPT, "nudge")).text;
      } catch (err) {
        this.log.warn(`group ${this.d.groupId}: reminder turn failed: ${err instanceof Error ? err.message : String(err)}`);
        return first.text;
      }
    } finally {
      this.cur = {};
    }
  }

  private resetBudgets(): void {
    for (const b of this.d.budgets ?? []) b.reset();
  }

  private personaPaths(): ReadonlySet<string> | undefined {
    try {
      return this.d.personaPaths?.();
    } catch (err) {
      this.log.warn(`group ${this.d.groupId}: could not list the persona files: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** The `.md` files outside the profile tree. A failing check is logged and counts as "nothing to report" (it must never block a run). */
  private unlinkedNotes(): string[] {
    try {
      return this.d.unlinked?.() ?? [];
    } catch (err) {
      this.log.warn(`group ${this.d.groupId}: could not check the note links: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** After a turn that created or wrote files: run the full check; if something is not linked, give the agent one turn to fix it. A failed turn is not fatal. */
  private async linkReminder(): Promise<void> {
    const paths = this.unlinkedNotes();
    if (paths.length === 0) return;
    this.log.warn(`group ${this.d.groupId}: ${paths.length} note(s) not linked from the persona tree; reminding once`);
    this.emit("turn.nudge", { reason: "unlinked notes", count: paths.length });
    try {
      await this.runTurn(linkNudgePrompt(paths), "nudge");
    } catch (err) {
      this.log.warn(`group ${this.d.groupId}: link reminder turn failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Re-reads the persona file. A failure keeps the previous text (the agent must not lose its profile over a hiccup). */
  private refreshPersona(): void {
    if (!this.d.persona) return;
    try {
      const text = this.d.persona()?.trim();
      this.pinned = text ? personaPinMessage(text) : undefined;
    } catch (err) {
      this.log.warn(`group ${this.d.groupId}: could not read the persona file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Trace event tagged with the group and, while a run is in progress, its `run` and current `turn`. */
  private emit(event: string, data: Record<string, unknown> = {}): void {
    this.events.emit(event, { ...this.cur, ...data });
  }

  /** One model turn: the prompt, the agent's whole tool loop, then persistence. A failed turn leaves no trace. */
  private async runTurn(prompt: string, kind: "message" | "flush" | "nudge", images?: ImageContent[]): Promise<{ text: string; sent: boolean; wrote: boolean }> {
    const state = this.d.session.agent.state;
    const from = state.messages.length;
    this.cur = { ...this.cur, turn: `t${++this.turnCount}`, kind };
    const t0 = Date.now();
    this.emit("turn.start", { prompt_chars: prompt.length, images: images?.length ?? 0, context_messages: from, context_tokens: this.contextTokens(prompt, imageTokens(images)), prompt: preview(this.events, prompt) });
    let added: AgentMessage[];
    try {
      await this.d.session.prompt(prompt, images?.length ? { images } : undefined);
      added = state.messages.slice(from);
    } catch (err) {
      this.setTranscript(state.messages.slice(0, from));
      this.emit("turn.rollback", { ms: Date.now() - t0, reason: "model call threw", error: err });
      throw err;
    }
    const last = added.findLast((m) => m.role === "assistant");
    if (!last || last.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
      // A failed turn leaves no trace: not in memory, not in the database.
      this.setTranscript(state.messages.slice(0, from));
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
    const sent = added.some((m) => m.role === "toolResult" && SPEAK_TOOLS.includes(m.toolName) && !m.isError);
    const wrote = added.some((m) => m.role === "toolResult" && (m.toolName === "write" || m.toolName === "edit") && !m.isError);
    return { text, sent, wrote };
  }

  /**
   * Replaces the live transcript. Pi 1.x rebuilds `agent.state.messages` from its SessionManager before every request, so
   * assigning to `state.messages` alone is silently undone (the model would see none of the history, or a rolled-back turn).
   * The SessionManager is in-memory; our own persistence is the database.
   */
  private setTranscript(messages: AgentMessage[]): void {
    const { session } = this.d;
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
      this.setTranscript(restored);
      this.log.info(`group ${this.d.groupId}: restored ${messages.length} message(s)${archive ? " + archive" : ""}`);
    }
  }

  /** The agent's profile is part of the view sent to the model, in front of everything (the archive included); it is not stored history. */
  private installPersonaPin(): void {
    const agent = this.d.session.agent;
    const previous = agent.transformContext;
    agent.transformContext = async (messages, signal) => {
      const view = previous ? await previous(messages, signal) : messages;
      return this.pinned ? [this.pinned, ...view] : view; // the prefix only changes when the file does
    };
  }

  /**
   * Just before compaction would retire older history, give the agent one turn to write what matters
   * into its files (without `send`: this turn must not speak in the group). Runs once per cycle.
   * A failed flush is logged and not fatal: the context must still be bounded.
   */
  private async flushMemoryIfNeeded(prompt: string, imageTokens = 0): Promise<void> {
    const { session, context: c, groupId } = this.d;
    if (this.flushed) return;
    const tokens = this.contextTokens(prompt, imageTokens);
    const threshold = c.compactTokens * c.flushRatio;
    if (tokens <= threshold) return;

    this.log.info(`group ${groupId}: context ~${tokens} tokens, nearing compaction at ${c.compactTokens}; asking the agent to save memory`);
    this.emit("flush.start", { tokens, threshold, compact_at: c.compactTokens });
    this.emit("conv.state", { from: "fresh", to: "flushing", reason: "context near compaction" });
    const t0 = Date.now();
    const tools = session.getActiveToolNames();
    session.setActiveToolsByName(tools.filter((n) => !SPEAK_TOOLS.includes(n)));
    try {
      const flush = await this.runTurn(MEMORY_FLUSH_PROMPT, "flush");
      this.flushed = true;
      this.d.store.setFlushed(groupId);
      if (flush.wrote) await this.linkReminder(); // the flush turn writes files too; still without the speak tools
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

  /** `imageTokens`: what the pictures attached to the prompt will cost. */
  private contextTokens(prompt: string, imageTokens = 0): number {
    const { session } = this.d;
    const pin = this.pinned ? estimateMessageTokens(this.pinned) : 0;
    return estimateContextTokens(session.systemPrompt, session.agent.state.messages) + pin + estimateTextTokens(prompt) + imageTokens;
  }

  /** Size of the context the next request would carry (the estimate the compaction thresholds use). */
  estimateContext(): number {
    return this.contextTokens("");
  }

  /**
   * Archives everything now, whatever the size (the console `compact` command). Must not overlap a run: the responder
   * serialises it with the group's runs. Returns undefined when there is nothing to archive.
   */
  async compact(): Promise<{ archived: number; tokensBefore: number; tokensAfter: number } | undefined> {
    const state = this.d.session.agent.state;
    const offset = this.archived ? 1 : 0;
    if (state.messages.length <= offset) return undefined;
    this.cur = {};
    return this.archiveThrough(state.messages.length, offset, this.contextTokens(""), "manual");
  }

  /**
   * Forgets the whole context, archive included (the console `clear` command); the group's chat log, the files and the
   * profile stay. Must not overlap a run: the responder serialises it with the group's runs. Returns the live messages dropped.
   */
  clear(why: "manual" | "cache expired" = "manual"): number {
    const dropped = this.d.store.clear(this.d.groupId);
    const tokens = this.contextTokens("");
    this.setTranscript([]);
    this.seqs = [];
    this.archiveSource = "";
    this.archived = false;
    this.flushed = false;
    this.cur = {};
    this.log.success(`group ${this.d.groupId}: cleared the context (${dropped} message(s), ~${tokens} tokens)`);
    this.emit("conv.state", { from: "any", to: "fresh", reason: why === "manual" ? "manual clear" : "clear after cache expiry", dropped_messages: dropped, tokens_before: tokens });
    return dropped;
  }

  /** Idle time since the last model request ended (the provider's cache is refreshed by it); undefined = no request in the history. */
  private cacheIdleMs(): number | undefined {
    const last = this.d.session.agent.state.messages.findLast((m) => m.role === "assistant");
    if (!last || last.role !== "assistant") return undefined;
    return (this.d.now?.() ?? Date.now()) - (last.timestamp + (last.durationMs ?? 0));
  }

  /**
   * The prompt cache is gone (no request for longer than the TTL), so the next request pays for re-writing the whole prefix anyway:
   * archive the entire live context first, if that shrinks the request a lot. Skipped (nothing changes) when the saving is small -
   * and never done while the cache is alive, where it would throw away a cheap cache hit. Lossless: no memory flush.
   */
  private async compactIfCacheExpired(prompt: string, imageTokens = 0): Promise<void> {
    const cfg = this.d.cacheCompact;
    if (!cfg?.enabled) return;
    const idle = this.cacheIdleMs();
    if (idle === undefined || idle <= cfg.ttlMs) return;
    const state = this.d.session.agent.state;
    const offset = this.archived ? 1 : 0;
    if (state.messages.length <= offset) return;
    const tokens = this.contextTokens(prompt, imageTokens);
    this.emit("cache.expired", { idle_ms: idle, ttl_ms: cfg.ttlMs, tokens });
    const accept = (saved: number) => saved >= cfg.minSavedTokens && saved >= tokens * cfg.minSavedRatio;
    const done = await this.archiveThrough(state.messages.length, offset, tokens, "cache expired", accept);
    if (done) return;
    // Compacting saves too little. Forgetting everything saves the whole live transcript (archive included).
    if (cfg.clearFallback && accept(estimateMessagesTokens(state.messages))) {
      this.emit("cache.clear", { tokens, saved_tokens: estimateMessagesTokens(state.messages) });
      this.clear("cache expired");
      return;
    }
    this.emit("compact.skip", { tokens, reason: "cache expired but compaction would save too little" });
  }

  /** Snap-compact older history once the context passes the threshold. */
  private async compactIfNeeded(prompt: string, imageTokens = 0): Promise<void> {
    const { context: c, groupId } = this.d;
    const tokens = this.contextTokens(prompt, imageTokens);
    if (tokens <= c.compactTokens) return;

    const offset = this.archived ? 1 : 0;
    const cut = this.findCut(this.d.session.agent.state.messages, offset);
    if (cut <= offset) {
      this.log.warn(`group ${groupId}: context ~${tokens} tokens but no complete turn is older than the recent window; not compacting`);
      this.emit("compact.skip", { tokens, threshold: c.compactTokens, reason: "no complete turn older than the recent window" });
      return;
    }
    await this.archiveThrough(cut, offset, tokens, "threshold");
  }

  /** Moves messages [offset, cut) into the archive (memory + database); `cut` must be a turn start or the end of the transcript. */
  private async archiveThrough(cut: number, offset: number, tokens: number, reason: "threshold" | "manual" | "cache expired", accept?: (savedTokens: number) => boolean) {
    const { session, groupId } = this.d;
    const state = session.agent.state;
    const messages = state.messages;
    const t0 = Date.now();
    const source = extendArchiveSource(this.archiveSource, serializeForArchive(messages.slice(offset, cut), { personaPaths: this.personaPaths() }), this.budget);
    const archive = await buildArchiveMessage(source, this.budget);
    if (accept) {
      // what the request would shrink by: the retired messages (and the old archive message) are replaced by the new archive
      const saved = estimateMessagesTokens(messages.slice(0, cut)) - estimateMessageTokens(archive);
      if (!accept(saved)) return undefined;
    }

    const throughSeq = this.seqs[cut - offset - 1]!;
    this.setTranscript([archive, ...messages.slice(cut)]);
    this.seqs = this.seqs.slice(cut - offset);
    this.archiveSource = source;
    this.archived = true;
    const wasFlushed = this.flushed;
    this.flushed = false;
    this.d.store.archive(groupId, throughSeq, source);
    const after = estimateContextTokens(session.systemPrompt, state.messages);
    this.log.success(`group ${groupId}: compacted ${cut - offset} message(s) into the archive (~${tokens} -> ~${after} tokens)`);
    this.emit("compact.done", { reason, archived_messages: cut - offset, kept_messages: messages.length - cut, tokens_before: tokens, tokens_after: after, archive_chars: source.length, through_seq: throughSeq, ms: Date.now() - t0 });
    this.emit("conv.state", { from: wasFlushed ? "flushed" : "fresh", to: "fresh", reason: reason === "manual" ? "manual compaction" : reason === "cache expired" ? "compaction after cache expiry" : "compaction" });
    return { archived: cut - offset, tokensBefore: tokens, tokensAfter: after };
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
