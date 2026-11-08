import { noopLogger } from "./logger.js";
import type { Conversation, ConversationFactory, GroupMessage, GroupResponder, EventLog, Logger, PendingMessage, WakeConfig } from "./types.js";
import type { PendingStore } from "./pending-store.js";
import { noopEventLog } from "./trace/event-log.js";
import { identityNotice } from "./context/identity.js";
import { element } from "./xml.js";

/**
 * How a group message is presented to the agent: a `<message>` element with time, message id (for `send`'s
 * `reply_to`), `reply_to` (the id of the message it answers, replies only), sender and, if it is meant for the bot,
 * `addressed="true"`. Nickname and text come from group members and are escaped, so they cannot forge tags. The group is implicit: each agent serves one.
 */
export function formatPrompt(msg: GroupMessage, addressed = false): string {
  const time = new Date(msg.ts * 1000).toLocaleString("sv-SE");
  return element("message", { time, id: msg.messageId, reply_to: msg.replyToMessageId, sender: msg.nickname, user_id: msg.userId, addressed: addressed ? "true" : undefined }, msg.text);
}

/** The user turn for a batch: who the agent is on the platform, then one `<message>` per queued message. */
export function formatBatch(batch: PendingMessage[]): string {
  return [identityNotice(batch[0]!.msg.selfId), ...batch.map((p) => formatPrompt(p.msg, p.addressed))].join("\n\n");
}

/** Waiting time of a Poisson process with the given mean: exponentially distributed (inverse-CDF sampling). */
export function sampleExponential(meanMs: number, random: () => number = Math.random): number {
  return -meanMs * Math.log(1 - random()); // random() is in [0, 1), so the log argument is in (0, 1]
}

/** idle: nothing queued; waiting: messages queued, wake-up scheduled; running: the agent is being run on a batch. */
type GroupPhase = "idle" | "waiting" | "running";

interface GroupState {
  pending: PendingMessage[];
  /** The scheduled wake-up, if any; `addressed` = it was drawn with the short mean. */
  timer?: { handle: ReturnType<typeof setTimeout>; due: number; addressed: boolean };
  /** Runs of one group are chained so they never overlap. */
  tail: Promise<void>;
  phase: GroupPhase;
  events: EventLog;
}

export interface PiResponderOptions {
  wake: WakeConfig;
  /** Where the queue is kept so it survives a restart; omit to keep it in memory only. */
  pending?: PendingStore;
  /** Uniform [0, 1) source; replaceable in tests. */
  random?: () => number;
  logger?: Logger;
  /** Structured trace of queueing, wake-ups, runs and the group's state transitions. */
  events?: EventLog;
}

/**
 * One agent conversation per group. Messages do not each cost a model call: they queue up, and the
 * agent is woken at the arrival times of a Poisson process (exponential gaps, memoryless), then sees
 * everything queued so far in one prompt. The clock starts with the first pending message; a message
 * addressed to the bot can only pull the wake-up earlier (it adds an independent, faster process).
 * Runs of one group never overlap; messages arriving during a run wait for the next wake-up.
 */
export class PiResponder implements GroupResponder {
  private readonly conversations = new Map<string, Promise<Conversation>>();
  private readonly groups = new Map<string, GroupState>();
  private readonly random: () => number;
  private readonly log: Logger;
  private readonly events: EventLog;
  private runCount = 0;

  constructor(
    private readonly createConversation: ConversationFactory,
    private readonly opts: PiResponderOptions,
  ) {
    this.random = opts.random ?? Math.random;
    this.log = (opts.logger ?? noopLogger).withTag("responder");
    this.events = opts.events ?? noopEventLog;
  }

  notify(msg: GroupMessage, addressed: boolean): void {
    try {
      this.opts.pending?.add(msg, addressed);
    } catch (err) {
      this.log.error(`could not persist pending message in group ${msg.groupId} (a restart would lose it): ${err instanceof Error ? err.message : String(err)}`);
      this.events.emit("queue.persist_failed", { group: msg.groupId, message_id: msg.messageId, error: err });
    }
    this.enqueue({ msg, addressed });
  }

  /**
   * After a restart: puts back the messages that were waiting (or being handled when the process died) and restarts
   * their wake-up clocks. Messages of groups `accept` rejects (e.g. no longer in QQ_GROUPS) are discarded.
   */
  restore(accept: (groupId: string) => boolean = () => true): number {
    const rows = this.opts.pending?.load() ?? [];
    const kept = rows.filter((p) => accept(p.msg.groupId));
    for (const p of rows) if (!accept(p.msg.groupId)) this.opts.pending?.remove(p.msg.groupId, [p.msg.messageId]);
    for (const p of kept) this.enqueue(p, "restored");
    if (kept.length > 0) this.log.info(`restored ${kept.length} pending message(s) from the database`);
    this.events.emit("queue.restore", { found: rows.length, restored: kept.length, discarded: rows.length - kept.length });
    return kept.length;
  }

  private enqueue(p: PendingMessage, origin: "live" | "restored" = "live"): void {
    const groupId = p.msg.groupId;
    const group = this.group(groupId);
    group.pending.push(p);
    group.events.emit("queue.add", { message_id: p.msg.messageId, addressed: p.addressed, origin, queued: group.pending.length });
    if (group.phase === "idle") this.setPhase(group, "waiting", origin === "restored" ? "restored message" : "message arrived");
    const { timer } = group;
    if (timer && (timer.addressed || !p.addressed)) return; // an equal or faster clock is already running

    const mean = p.addressed ? this.opts.wake.addressedMeanMs : this.opts.wake.chatMeanMs;
    const due = Date.now() + sampleExponential(mean, this.random);
    if (timer && timer.due <= due) {
      timer.addressed = true; // the earlier of the two processes stays; later addressed messages need no new draw
      return;
    }
    if (timer) clearTimeout(timer.handle);
    group.timer = { handle: setTimeout(() => this.wake(groupId), Math.max(0, due - Date.now())), due, addressed: p.addressed };
    group.events.emit("wake.scheduled", { in_ms: Math.max(0, Math.round(due - Date.now())), mean_ms: mean, addressed: p.addressed, replaced: timer !== undefined });
  }

  private group(groupId: string): GroupState {
    let g = this.groups.get(groupId);
    if (!g) this.groups.set(groupId, (g = { pending: [], tail: Promise.resolve(), phase: "idle", events: this.events.child({ group: groupId }) }));
    return g;
  }

  /** Records a transition of the group's state machine (only real changes). */
  private setPhase(group: GroupState, to: GroupPhase, reason: string): void {
    if (group.phase === to) return;
    group.events.emit("group.state", { from: group.phase, to, reason, queued: group.pending.length });
    group.phase = to;
  }

  private wake(groupId: string): void {
    const group = this.group(groupId);
    group.timer = undefined;
    group.events.emit("wake.fire", { queued: group.pending.length, busy: group.phase === "running" });
    group.tail = group.tail.then(() => this.run(groupId, group));
  }

  /**
   * Never rejects: a failed run is logged and its batch dropped (the turn is rolled back by the conversation; a
   * retry could loop forever). The batch leaves the database only once the run is over, so a crash replays it.
   */
  private async run(groupId: string, group: GroupState): Promise<void> {
    const batch = group.pending.splice(0);
    if (batch.length === 0) return;
    const run = `r${Date.now().toString(36)}.${++this.runCount}`;
    const t0 = Date.now();
    this.log.info(`waking agent for group ${groupId} with ${batch.length} message(s)`);
    this.setPhase(group, "running", "wake-up");
    group.events.emit("run.start", {
      run,
      messages: batch.length,
      addressed: batch.filter((p) => p.addressed).length,
      message_ids: batch.map((p) => p.msg.messageId),
      oldest_message_age_ms: t0 - Math.min(...batch.map((p) => p.msg.ts)) * 1000,
    });
    let error: unknown;
    try {
      let conversation = this.conversations.get(groupId);
      if (!conversation) {
        conversation = this.createConversation(groupId);
        this.conversations.set(groupId, conversation);
        conversation.catch(() => this.conversations.delete(groupId)); // retry creation next time
      }
      await (await conversation).ask(formatBatch(batch), { run, addressed: batch.some((p) => p.addressed) });
    } catch (err) {
      error = err;
      this.log.error(`agent run failed in group ${groupId}, dropped ${batch.length} message(s): ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      this.opts.pending?.remove(groupId, batch.map((p) => p.msg.messageId));
    } catch (err) {
      this.log.error(`could not clear handled messages of group ${groupId} (they may replay after a restart): ${err instanceof Error ? err.message : String(err)}`);
      group.events.emit("queue.clear_failed", { run, error: err });
    }
    group.events.emit("run.end", { run, ok: error === undefined, ms: Date.now() - t0, dropped: error === undefined ? 0 : batch.length, error });
    this.setPhase(group, group.pending.length > 0 ? "waiting" : "idle", group.pending.length > 0 ? "messages arrived during the run" : "queue empty");
  }
}
