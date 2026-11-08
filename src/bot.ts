import { noopLogger } from "./logger.js";
import type { BotOptions, GroupMessage, Logger, OutboundSegment } from "./types.js";

/** QQ rejects very long messages; stay well under the limit. */
export const MAX_REPLY_CHARS = 1500;
const MAX_REMEMBERED_SENT = 1000;

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
  private readonly sent = new Set<string>(); // "group:messageId" of messages this bot sent
  private readonly log: Logger;

  constructor(private readonly opts: BotOptions) {
    this.log = (opts.logger ?? noopLogger).withTag("bot");
  }

  handleGroupMessage(msg: GroupMessage): void {
    const { store, groups } = this.opts;
    if (groups && !groups.has(msg.groupId)) return;

    store.insert(msg);
    this.log.debug(`group ${msg.groupId} ${msg.nickname}(${msg.userId}): ${msg.text.slice(0, 80)}`);
    if (msg.isSelf) return;
    this.opts.responder.notify(msg, this.isAddressedToBot(msg));
  }

  /** Posts `text` to `groupId`, quoting `replyTo` on the first chunk. Throws if any chunk fails to send. */
  async sendText(groupId: string, text: string, replyTo?: string): Promise<void> {
    const chunks = splitReply(text);
    for (const [i, chunk] of chunks.entries()) {
      const segments: OutboundSegment[] = [{ type: "text", data: { text: chunk } }];
      if (i === 0 && replyTo) segments.unshift({ type: "reply", data: { id: replyTo } });
      try {
        const { messageId } = await this.opts.api.sendGroupMessage(groupId, segments);
        this.remember(groupId, messageId);
      } catch (err) {
        throw new Error(`send to group ${groupId} failed after ${i}/${chunks.length} message(s): ${errText(err)}`);
      }
    }
    this.log.success(`sent to group ${groupId} (${text.length} chars, ${chunks.length} message(s))`);
  }

  private isAddressedToBot(msg: GroupMessage): boolean {
    if (msg.mentionsSelf) return true;
    if (!msg.replyToMessageId) return false;
    if (this.sent.has(`${msg.groupId}:${msg.replyToMessageId}`)) return true;
    return this.opts.store.get("qq", msg.groupId, msg.replyToMessageId)?.userId === msg.selfId;
  }

  private remember(groupId: string, messageId: string): void {
    this.sent.add(`${groupId}:${messageId}`);
    if (this.sent.size > MAX_REMEMBERED_SENT) this.sent.delete(this.sent.values().next().value!);
  }
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
