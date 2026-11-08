import type { Conversation, ConversationFactory, GroupMessage, GroupResponder } from "./types.js";

/** How a group message is presented to the agent: who said it, where, when. */
export function formatPrompt(msg: GroupMessage): string {
  const when = new Date(msg.ts * 1000).toLocaleString("sv-SE");
  return `[群 ${msg.groupId} · ${when}] ${msg.nickname}(${msg.userId}):\n${msg.text}`;
}

/** One agent conversation per group; messages within a group are answered strictly one at a time. */
export class PiResponder implements GroupResponder {
  private readonly conversations = new Map<string, Promise<Conversation>>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly createConversation: ConversationFactory) {}

  respond(msg: GroupMessage): Promise<string> {
    const prev = this.queues.get(msg.groupId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.run(msg));
    this.queues.set(msg.groupId, next);
    return next;
  }

  private async run(msg: GroupMessage): Promise<string> {
    let conversation = this.conversations.get(msg.groupId);
    if (!conversation) {
      conversation = this.createConversation(msg.groupId);
      this.conversations.set(msg.groupId, conversation);
      conversation.catch(() => this.conversations.delete(msg.groupId)); // retry creation next time
    }
    return (await conversation).ask(formatPrompt(msg));
  }
}
