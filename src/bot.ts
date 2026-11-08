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
 * Core bot logic. Sees only validated `GroupMessage`s: stores every message of the
 * handled groups, and answers when it is @-mentioned or someone replies to one of its messages.
 */
export class Bot {
  private readonly sent = new Set<string>(); // "group:messageId" of messages this bot sent
  private readonly log: Logger;

  constructor(private readonly opts: BotOptions) {
    this.log = (opts.logger ?? noopLogger).withTag("bot");
  }

  async handleGroupMessage(msg: GroupMessage): Promise<void> {
    const { store, groups } = this.opts;
    if (groups && !groups.has(msg.groupId)) return;

    store.insert(msg);
    this.log.debug(`group ${msg.groupId} ${msg.nickname}(${msg.userId}): ${msg.text.slice(0, 80)}`);
    if (msg.isSelf || !this.isAddressedToBot(msg)) return;
    this.log.info(`answering ${msg.nickname} in group ${msg.groupId}`);

    let reply: string;
    try {
      reply = await this.opts.responder.respond(msg);
    } catch (err) {
      this.log.error(`responder failed in group ${msg.groupId}: ${errText(err)}`);
      return;
    }
    const chunks = splitReply(reply);
    for (const [i, chunk] of chunks.entries()) {
      const segments: OutboundSegment[] = [{ type: "text", data: { text: chunk } }];
      if (i === 0) segments.unshift({ type: "reply", data: { id: msg.messageId } });
      try {
        const { messageId } = await this.opts.api.sendGroupMessage(msg.groupId, segments);
        this.remember(msg.groupId, messageId);
      } catch (err) {
        this.log.error(`send failed in group ${msg.groupId}: ${errText(err)}`);
        return;
      }
    }
    this.log.success(`replied in group ${msg.groupId} to ${msg.nickname} (${reply.length} chars, ${chunks.length} message(s))`);
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
