import type { Database } from "bun:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { StoredAgentMessage, StoredArchive } from "./types.js";

/** Persists agent conversations (live messages + the compacted archive) in the shared SQLite file. */
export class ConversationStore {
  constructor(private readonly db: Database) {}

  /** Whether the memory flush already ran in this group's current compaction cycle. */
  loadFlushed(groupId: string): boolean {
    return this.db.query("SELECT flushed FROM conversation_flags WHERE group_id = ?").get(groupId) !== null;
  }

  setFlushed(groupId: string): void {
    this.db.query("INSERT OR REPLACE INTO conversation_flags (group_id, flushed) VALUES (?, 1)").run(groupId);
  }

  load(groupId: string): { archive?: StoredArchive; messages: StoredAgentMessage[] } {
    const a = this.db.query("SELECT through_seq, source_text FROM agent_archives WHERE group_id = ?").get(groupId) as
      | { through_seq: number; source_text: string }
      | null;
    const rows = this.db
      .query("SELECT seq, message FROM agent_messages WHERE group_id = ? ORDER BY seq")
      .all(groupId) as { seq: number; message: string }[];
    return {
      archive: a ? { throughSeq: a.through_seq, sourceText: a.source_text } : undefined,
      messages: rows.map((r) => ({ seq: r.seq, message: JSON.parse(r.message) as AgentMessage })),
    };
  }

  /** Appends messages and returns their sequence numbers. */
  append(groupId: string, messages: readonly AgentMessage[]): number[] {
    return this.db
      .transaction(() => {
        const row = this.db.query("SELECT COALESCE(MAX(seq), 0) AS m FROM agent_messages WHERE group_id = ?").get(groupId) as { m: number };
        const archived = this.db.query("SELECT through_seq FROM agent_archives WHERE group_id = ?").get(groupId) as { through_seq: number } | null;
        let seq = Math.max(row.m, archived?.through_seq ?? 0);
        const insert = this.db.query("INSERT INTO agent_messages (group_id, seq, message) VALUES (?, ?, ?)");
        return messages.map((m) => {
          insert.run(groupId, ++seq, JSON.stringify(m));
          return seq;
        });
      })
      .immediate();
  }

  /** Retires every message with seq <= throughSeq: the archive text replaces them. */
  archive(groupId: string, throughSeq: number, sourceText: string): void {
    this.db
      .transaction(() => {
        this.db
          .query(
            `INSERT INTO agent_archives (group_id, through_seq, source_text, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (group_id) DO UPDATE SET through_seq = excluded.through_seq, source_text = excluded.source_text, updated_at = excluded.updated_at`,
          )
          .run(groupId, throughSeq, sourceText, Math.floor(Date.now() / 1000));
        this.db.query("DELETE FROM agent_messages WHERE group_id = ? AND seq <= ?").run(groupId, throughSeq);
        this.db.query("DELETE FROM conversation_flags WHERE group_id = ?").run(groupId); // a new compaction cycle: the memory flush is due again
      })
      .immediate();
  }

  /** Drops messages with seq > `afterSeq` (rolling back a failed turn). */
  truncate(groupId: string, afterSeq: number): void {
    this.db.query("DELETE FROM agent_messages WHERE group_id = ? AND seq > ?").run(groupId, afterSeq);
  }
}
