import { noopLogger } from "./logger.js";
import type { Conversation, ConversationFactory, GroupMessage, GroupResponder, Logger, WakeConfig } from "./types.js";

/** How a group message is presented to the agent: time, message id (for `send`'s `reply_to`), speaker, text. The group is implicit: each agent serves exactly one. */
export function formatPrompt(msg: GroupMessage, addressed = false): string {
  const when = new Date(msg.ts * 1000).toLocaleString("sv-SE");
  const flag = addressed ? " 【对你说】" : "";
  return `[${when} · #${msg.messageId}] ${msg.nickname}(${msg.userId})${flag}:\n${msg.text}`;
}

/** Waiting time of a Poisson process with the given mean: exponentially distributed (inverse-CDF sampling). */
export function sampleExponential(meanMs: number, random: () => number = Math.random): number {
  return -meanMs * Math.log(1 - random()); // random() is in [0, 1), so the log argument is in (0, 1]
}

interface Pending {
  msg: GroupMessage;
  addressed: boolean;
}

interface GroupState {
  pending: Pending[];
  /** The scheduled wake-up, if any; `addressed` = it was drawn with the short mean. */
  timer?: { handle: ReturnType<typeof setTimeout>; due: number; addressed: boolean };
  /** Runs of one group are chained so they never overlap. */
  tail: Promise<void>;
}

export interface PiResponderOptions {
  wake: WakeConfig;
  /** Uniform [0, 1) source; replaceable in tests. */
  random?: () => number;
  logger?: Logger;
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

  constructor(
    private readonly createConversation: ConversationFactory,
    private readonly opts: PiResponderOptions,
  ) {
    this.random = opts.random ?? Math.random;
    this.log = (opts.logger ?? noopLogger).withTag("responder");
  }

  notify(msg: GroupMessage, addressed: boolean): void {
    const group = this.group(msg.groupId);
    group.pending.push({ msg, addressed });
    const { timer } = group;
    if (timer && (timer.addressed || !addressed)) return; // an equal or faster clock is already running

    const due = Date.now() + sampleExponential(addressed ? this.opts.wake.addressedMeanMs : this.opts.wake.chatMeanMs, this.random);
    if (timer && timer.due <= due) {
      timer.addressed = true; // the earlier of the two processes stays; later addressed messages need no new draw
      return;
    }
    if (timer) clearTimeout(timer.handle);
    group.timer = { handle: setTimeout(() => this.wake(msg.groupId), Math.max(0, due - Date.now())), due, addressed };
  }

  private group(groupId: string): GroupState {
    let g = this.groups.get(groupId);
    if (!g) this.groups.set(groupId, (g = { pending: [], tail: Promise.resolve() }));
    return g;
  }

  private wake(groupId: string): void {
    const group = this.group(groupId);
    group.timer = undefined;
    group.tail = group.tail.then(() => this.run(groupId, group));
  }

  /** Never rejects: a failed run is logged and its batch dropped (the turn is rolled back by the conversation; a retry could loop forever). */
  private async run(groupId: string, group: GroupState): Promise<void> {
    const batch = group.pending.splice(0);
    if (batch.length === 0) return;
    this.log.info(`waking agent for group ${groupId} with ${batch.length} message(s)`);
    try {
      let conversation = this.conversations.get(groupId);
      if (!conversation) {
        conversation = this.createConversation(groupId);
        this.conversations.set(groupId, conversation);
        conversation.catch(() => this.conversations.delete(groupId)); // retry creation next time
      }
      await (await conversation).ask(batch.map((p) => formatPrompt(p.msg, p.addressed)).join("\n\n"));
    } catch (err) {
      this.log.error(`agent run failed in group ${groupId}, dropped ${batch.length} message(s): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
