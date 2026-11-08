import type { Database } from "bun:sqlite";
import type { GroupMessage, PendingMessage } from "./types.js";

/** Persists the messages waiting for an agent wake-up, so a restart does not forget them. */
export class PendingStore {
  constructor(private readonly db: Database) {}

  /** Idempotent per (group, message id). */
  add(msg: GroupMessage, addressed: boolean): void {
    this.db
      .query("INSERT OR IGNORE INTO pending_messages (group_id, message_id, addressed, payload) VALUES (?, ?, ?, ?)")
      .run(msg.groupId, msg.messageId, addressed ? 1 : 0, JSON.stringify(msg));
  }

  /** Forgets messages the agent has been run on. */
  remove(groupId: string, messageIds: readonly string[]): void {
    const del = this.db.query("DELETE FROM pending_messages WHERE group_id = ? AND message_id = ?");
    this.db.transaction(() => {
      for (const id of messageIds) del.run(groupId, id);
    })();
  }

  /** Everything still pending, oldest first. */
  load(): PendingMessage[] {
    const rows = this.db.query("SELECT addressed, payload FROM pending_messages ORDER BY seq").all() as { addressed: number; payload: string }[];
    return rows.map((r) => ({ msg: JSON.parse(r.payload) as GroupMessage, addressed: r.addressed === 1 }));
  }
}
