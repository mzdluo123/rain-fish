import type { Database } from "bun:sqlite";
import { toMatchQuery, tokenize } from "./db/tokenize.js";
import type { MessageRow, SearchHit, SearchQuery, SearchRow, StoredMessage } from "./types.js";

export const MAX_SEARCH_LIMIT = 50;

const toStored = (r: MessageRow): StoredMessage => ({
  platform: r.platform,
  groupId: r.group_id,
  messageId: r.message_id,
  userId: r.user_id,
  nickname: r.nickname,
  ts: r.ts,
  text: r.text,
});

export class MessageStore {
  constructor(private readonly db: Database) {}

  /** Stores a message and indexes it. Returns false if (platform, group, message id) was already stored. */
  insert(m: StoredMessage): boolean {
    const tx = this.db.transaction(() => {
      const res = this.db
        .query(
          `INSERT OR IGNORE INTO messages (platform, group_id, message_id, user_id, nickname, ts, text)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(m.platform, m.groupId, m.messageId, m.userId, m.nickname, m.ts, m.text);
      if (res.changes === 0) return false;
      this.db
        .query("INSERT INTO messages_fts (rowid, tokens) VALUES (?, ?)")
        .run(res.lastInsertRowid, tokenize(m.text).join(" "));
      return true;
    });
    return tx.immediate();
  }

  /** Number of stored messages of a group. */
  countGroup(groupId: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM messages WHERE group_id = ?").get(groupId) as { n: number }).n;
  }

  get(platform: string, groupId: string, messageId: string): StoredMessage | undefined {
    const row = this.db
      .query("SELECT * FROM messages WHERE platform = ? AND group_id = ? AND message_id = ?")
      .get(platform, groupId, messageId) as MessageRow | null;
    return row ? toStored(row) : undefined;
  }

  search(q: SearchQuery): SearchHit[] {
    const match = toMatchQuery(q.query);
    if (!match) return [];
    const where = ["messages_fts MATCH ?"];
    const args: (string | number)[] = [match];
    if (q.groupId !== undefined) {
      where.push("m.group_id = ?");
      args.push(q.groupId);
    }
    if (q.sender !== undefined) {
      where.push("(m.user_id = ? OR m.nickname = ?)");
      args.push(q.sender, q.sender);
    }
    if (q.since !== undefined) {
      where.push("m.ts >= ?");
      args.push(q.since);
    }
    if (q.until !== undefined) {
      where.push("m.ts <= ?");
      args.push(q.until);
    }
    args.push(Math.min(Math.max(Math.trunc(q.limit ?? 10), 1), MAX_SEARCH_LIMIT));
    const rows = this.db
      .query(
        `SELECT m.id, m.platform, m.group_id, m.message_id, m.user_id, m.nickname, m.ts, m.text,
                bm25(messages_fts) AS score
         FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
         WHERE ${where.join(" AND ")}
         ORDER BY score, m.ts DESC
         LIMIT ?`,
      )
      .all(...args) as SearchRow[];
    return rows.map((r) => ({ id: r.id, score: r.score, ...toStored(r) }));
  }
}
