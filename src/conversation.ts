import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { buildArchiveMessage, extendArchiveSource, serializeForArchive, type ArchiveBudget } from "./context/archive.js";
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens } from "./context/estimate.js";
import { pruneExpensive } from "./context/prune.js";
import type { ConversationStore } from "./conversation-store.js";
import { noopLogger } from "./logger.js";
import type { ContextConfig, Conversation, Logger } from "./types.js";

export interface PiConversationDeps {
  groupId: string;
  session: AgentSession;
  store: ConversationStore;
  context: ContextConfig;
  logger?: Logger;
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
  private archived = false;
  private archiveSource = "";
  private readonly log: Logger;

  private constructor(private readonly d: PiConversationDeps) {
    this.log = (d.logger ?? noopLogger).withTag("context");
  }

  static async create(deps: PiConversationDeps): Promise<PiConversation> {
    const c = new PiConversation(deps);
    await c.restore();
    c.installPruning();
    return c;
  }

  /** The underlying session, e.g. to subscribe to streaming events. */
  get session(): AgentSession {
    return this.d.session;
  }

  async ask(prompt: string): Promise<string> {
    await this.compactIfNeeded(prompt);
    const state = this.d.session.agent.state;
    const from = state.messages.length;
    let added: AgentMessage[];
    try {
      await this.d.session.prompt(prompt);
      added = state.messages.slice(from);
    } catch (err) {
      state.messages = state.messages.slice(0, from);
      throw err;
    }
    const last = added.findLast((m) => m.role === "assistant");
    if (!last || last.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
      // A failed turn leaves no trace: not in memory, not in the database.
      state.messages = state.messages.slice(0, from);
      throw new Error(last?.role === "assistant" ? (last.errorMessage ?? `model call ${last.stopReason}`) : "no reply from the model");
    }
    this.seqs.push(...this.d.store.append(this.d.groupId, added));
    return last.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
  }

  private get budget(): ArchiveBudget {
    return { model: this.d.session.model, archiveTokens: this.d.context.archiveTokens };
  }

  private async restore(): Promise<void> {
    const { archive, messages } = this.d.store.load(this.d.groupId);
    const restored: AgentMessage[] = [];
    if (archive) {
      this.archiveSource = archive.sourceText;
      this.archived = true;
      restored.push(await buildArchiveMessage(archive.sourceText, this.budget));
    }
    restored.push(...messages.map((m) => m.message));
    this.seqs = messages.map((m) => m.seq);
    if (restored.length > 0) {
      this.d.session.agent.state.messages = restored;
      this.log.info(`group ${this.d.groupId}: restored ${messages.length} message(s)${archive ? " + archive" : ""}`);
    }
  }

  /** Level 1: applied to the view sent to the model, so the stored history stays complete. */
  private installPruning(): void {
    const agent = this.d.session.agent;
    const previous = agent.transformContext;
    const { recentTokens, pruneMinTokens } = this.d.context;
    agent.transformContext = async (messages, signal) =>
      pruneExpensive(previous ? await previous(messages, signal) : messages, { recentTokens, minBlockTokens: pruneMinTokens });
  }

  /** Level 2: snap-compact older history once the (pruned) context passes the threshold. */
  private async compactIfNeeded(prompt: string): Promise<void> {
    const { session, context: c, groupId } = this.d;
    const state = session.agent.state;
    const view = pruneExpensive(state.messages, { recentTokens: c.recentTokens, minBlockTokens: c.pruneMinTokens });
    const tokens = estimateContextTokens(session.systemPrompt, view) + estimateTextTokens(prompt);
    if (tokens <= c.compactTokens) return;

    const offset = this.archived ? 1 : 0;
    const messages = state.messages;
    const cut = this.findCut(messages, offset);
    if (cut <= offset) {
      this.log.warn(`group ${groupId}: context ~${tokens} tokens but no complete turn is older than the recent window; not compacting`);
      return;
    }
    const source = extendArchiveSource(this.archiveSource, serializeForArchive(messages.slice(offset, cut)), this.budget);
    const archive = await buildArchiveMessage(source, this.budget);

    const throughSeq = this.seqs[cut - offset - 1]!;
    state.messages = [archive, ...messages.slice(cut)];
    this.seqs = this.seqs.slice(cut - offset);
    this.archiveSource = source;
    this.archived = true;
    this.d.store.archive(groupId, throughSeq, source);
    this.log.success(
      `group ${groupId}: compacted ${cut - offset} message(s) into the archive (~${tokens} -> ~${estimateContextTokens(session.systemPrompt, state.messages)} tokens)`,
    );
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
