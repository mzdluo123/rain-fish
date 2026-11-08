import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { GroupMessage, GroupResponder, SessionFactory } from "./types.js";

/** How a group message is presented to the agent: who said it, where, when. */
export function formatPrompt(msg: GroupMessage): string {
  const when = new Date(msg.ts * 1000).toLocaleString("sv-SE");
  return `[群 ${msg.groupId} · ${when}] ${msg.nickname}(${msg.userId}):\n${msg.text}`;
}

function lastAssistantText(session: AgentSession, from: number): string {
  const msg = session.state.messages.slice(from).findLast((m) => m.role === "assistant");
  if (!msg || msg.role !== "assistant") return "";
  if (msg.stopReason === "error") throw new Error(msg.errorMessage ?? "agent error");
  return msg.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim();
}

/** One agent conversation per group; messages within a group are answered strictly one at a time. */
export class PiResponder implements GroupResponder {
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly createSession: SessionFactory) {}

  respond(msg: GroupMessage): Promise<string> {
    const prev = this.queues.get(msg.groupId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.run(msg));
    this.queues.set(msg.groupId, next);
    return next;
  }

  private async run(msg: GroupMessage): Promise<string> {
    let session = this.sessions.get(msg.groupId);
    if (!session) {
      session = this.createSession(msg.groupId);
      this.sessions.set(msg.groupId, session);
      session.catch(() => this.sessions.delete(msg.groupId)); // retry creation next time
    }
    const s = await session;
    const from = s.state.messages.length;
    await s.prompt(formatPrompt(msg));
    return lastAssistantText(s, from);
  }
}
