import { noopLogger } from "./logger.js";
import { noopEventLog, preview } from "./trace/event-log.js";
import type { BotOptions, EventLog, GroupMessage, Logger, OutboundSegment } from "./types.js";

/** QQ rejects very long messages; stay well under the limit. */
export const MAX_REPLY_CHARS = 1500;

export function splitReply(text: string, max = MAX_REPLY_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    // Prefer breaking at a newline, then a space, in the back half of the window.
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > max / 2 ? cut : max;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Core bot logic. Sees only validated `GroupMessage`s: stores every message of the handled groups and
 * hands the others to the responder (flagging those addressed to the bot). It never answers itself:
 * the agent posts through `send`, which the factory binds to `sendText`.
 */
export class Bot {
  private selfId?: string;
  private readonly log: Logger;
  private readonly events: EventLog;

  constructor(private readonly opts: BotOptions) {
    this.log = (opts.logger ?? noopLogger).withTag("bot");
    this.events = opts.events ?? noopEventLog;
  }

  /** The bot's own QQ id, from the connection's lifecycle event (also learned from every incoming message). */
  noteSelfId(selfId: string): void {
    this.selfId = selfId;
  }

  handleGroupMessage(msg: GroupMessage): void {
    const { store, groups } = this.opts;
    if (groups && !groups.has(msg.groupId)) return;

    this.selfId = msg.selfId;
    const base = { group: msg.groupId, message_id: msg.messageId, user_id: msg.userId, chars: msg.text.length, self: msg.isSelf, mention: msg.mentionsSelf, reply_to: msg.replyToMessageId };
    if (!store.insert(msg)) {
      this.log.debug(`group ${msg.groupId}: duplicate message ${msg.messageId} ignored`);
      this.events.emit("msg.duplicate", { group: msg.groupId, message_id: msg.messageId });
      return; // already stored (and queued) once, e.g. a redelivered event
    }
    this.log.debug(`group ${msg.groupId} ${msg.nickname}(${msg.userId}): ${msg.text.slice(0, 80)}`);
    if (msg.isSelf) {
      this.events.emit("msg.in", { ...base, addressed: false, queued: false });
      return;
    }
    const addressed = this.isAddressedToBot(msg);
    this.events.emit("msg.in", { ...base, addressed, queued: true, text: preview(this.events, msg.text), nickname: this.events.captureContent ? msg.nickname : undefined });
    this.opts.responder.notify(msg, addressed);
  }

  /**
   * Posts `text` to `groupId`, quoting `replyTo` on the first chunk. Throws if any chunk fails to send.
   * Every sent chunk is also stored (as from the bot), so "a reply to the bot's message" is still recognised
   * after a restart and when NapCat does not report the bot's own messages.
   */
  async sendText(groupId: string, text: string, replyTo?: string): Promise<void> {
    const chunks = splitReply(text);
    for (const [i, chunk] of chunks.entries()) {
      const segments: OutboundSegment[] = [{ type: "text", data: { text: chunk } }];
      if (i === 0 && replyTo) segments.unshift({ type: "reply", data: { id: replyTo } });
      let messageId: string;
      try {
        ({ messageId } = await this.opts.api.sendGroupMessage(groupId, segments));
      } catch (err) {
        this.events.emit("msg.out_failed", { group: groupId, chunk: i, chunks: chunks.length, chars: chunk.length, error: err });
        throw new Error(`send to group ${groupId} failed after ${i}/${chunks.length} message(s): ${errText(err)}`);
      }
      this.events.emit("msg.out", { group: groupId, message_id: messageId, chunk: i, chunks: chunks.length, chars: chunk.length, reply_to: i === 0 ? replyTo : undefined, stored: this.selfId !== undefined, text: preview(this.events, chunk) });
      if (this.selfId) {
        this.opts.store.insert({ platform: "qq", groupId, messageId, userId: this.selfId, nickname: "bot", ts: Math.floor(Date.now() / 1000), text: chunk });
      } else {
        this.log.warn(`own id unknown yet: message ${messageId} in group ${groupId} not stored`);
      }
    }
    this.log.success(`sent to group ${groupId} (${text.length} chars, ${chunks.length} message(s))`);
  }

  private isAddressedToBot(msg: GroupMessage): boolean {
    if (msg.mentionsSelf) return true;
    if (!msg.replyToMessageId) return false;
    return this.opts.store.get("qq", msg.groupId, msg.replyToMessageId)?.userId === msg.selfId;
  }
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
