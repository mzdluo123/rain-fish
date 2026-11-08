import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { StoredImage } from "./types.js";

/** How the agent names a stored picture: `i42`. */
export const imageRef = (id: number): string => `i${id}`;

/** Parses `i42` / `42`; undefined for anything else. */
export function parseImageRef(s: string): number | undefined {
  const m = /^i?(\d{1,9})$/i.exec(s.trim());
  return m ? Number(m[1]) : undefined;
}

/**
 * Stored pictures of group messages (migration 0007). Identical bytes are one row. Every read is scoped to a group:
 * a picture is visible to a group only if a message of that group carried it.
 */
export class ImageStore {
  constructor(private readonly db: Database) {}

  /** Stores the picture (once per distinct content) and links it to the message. Returns its id. */
  put(groupId: string, messageId: string, idx: number, bytes: Uint8Array, mime: string, platform = "qq"): number {
    const sha = createHash("sha256").update(bytes).digest("hex");
    const now = Math.floor(Date.now() / 1000);
    return this.db
      .transaction(() => {
        this.db.query("INSERT OR IGNORE INTO images (sha256, mime, data, size, last_used) VALUES (?, ?, ?, ?, ?)").run(sha, mime, bytes, bytes.length, now);
        const id = (this.db.query("SELECT id FROM images WHERE sha256 = ?").get(sha) as { id: number }).id;
        this.db.query("UPDATE images SET last_used = ? WHERE id = ?").run(now, id);
        this.db.query("INSERT OR REPLACE INTO message_images (platform, group_id, message_id, idx, image_id) VALUES (?, ?, ?, ?, ?)").run(platform, groupId, messageId, idx, id);
        return id;
      })
      .immediate();
  }

  /** Links an already stored picture to another message (e.g. one the bot sent). */
  link(groupId: string, messageId: string, idx: number, imageId: number, platform = "qq"): void {
    this.db.query("INSERT OR REPLACE INTO message_images (platform, group_id, message_id, idx, image_id) VALUES (?, ?, ?, ?, ?)").run(platform, groupId, messageId, idx, imageId);
  }

  /** The picture, if this group has seen it; marks it as recently used. */
  get(groupId: string, id: number): StoredImage | undefined {
    const row = this.db
      .query(
        `SELECT i.id, i.mime, i.data, i.size FROM images i
         WHERE i.id = ? AND EXISTS (SELECT 1 FROM message_images m WHERE m.image_id = i.id AND m.group_id = ?)`,
      )
      .get(id, groupId) as { id: number; mime: string; data: Uint8Array; size: number } | null;
    if (!row) return undefined;
    this.db.query("UPDATE images SET last_used = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), id);
    return { id: row.id, mime: row.mime, size: row.size, data: Buffer.from(row.data) };
  }

  /** Ids of the pictures of one message, in order (empty if none are stored). */
  idsOf(groupId: string, messageId: string, platform = "qq"): number[] {
    const rows = this.db.query("SELECT image_id FROM message_images WHERE platform = ? AND group_id = ? AND message_id = ? ORDER BY idx").all(platform, groupId, messageId) as { image_id: number }[];
    return rows.map((r) => r.image_id);
  }

  /** The stored picture of message slot `idx`, without marking it used (used when the batch is shown to the model). */
  slot(groupId: string, messageId: string, idx: number, platform = "qq"): StoredImage | undefined {
    const row = this.db
      .query(
        `SELECT i.id, i.mime, i.data, i.size FROM message_images m JOIN images i ON i.id = m.image_id
         WHERE m.platform = ? AND m.group_id = ? AND m.message_id = ? AND m.idx = ?`,
      )
      .get(platform, groupId, messageId, idx) as { id: number; mime: string; data: Uint8Array; size: number } | null;
    return row ? { id: row.id, mime: row.mime, size: row.size, data: Buffer.from(row.data) } : undefined;
  }

  totalBytes(): number {
    return (this.db.query("SELECT COALESCE(SUM(size), 0) AS n FROM images").get() as { n: number }).n;
  }

  /**
   * Deletes the least recently used pictures (and their message links) until at most `maxBytes` are stored, then gives the freed
   * pages back to the file system (the database file shrinks; without this it would only ever grow). Returns how many went.
   */
  evict(maxBytes: number): number {
    const removed = this.evictRows(maxBytes);
    if (removed > 0) this.shrink();
    return removed;
  }

  /** Hands free pages back to the OS and trims the write-ahead log. Best effort: a busy database just keeps the pages for reuse. */
  private shrink(): void {
    try {
      this.db.run("PRAGMA incremental_vacuum");
      this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* the space is reused by the next pictures anyway */
    }
  }

  private evictRows(maxBytes: number): number {
    return this.db
      .transaction(() => {
        let total = this.totalBytes();
        if (total <= maxBytes) return 0;
        const rows = this.db.query("SELECT id, size FROM images ORDER BY last_used, id").all() as { id: number; size: number }[];
        let removed = 0;
        for (const r of rows) {
          if (total <= maxBytes) break;
          this.db.query("DELETE FROM message_images WHERE image_id = ?").run(r.id);
          this.db.query("DELETE FROM images WHERE id = ?").run(r.id);
          total -= r.size;
          removed++;
        }
        return removed;
      })
      .immediate();
  }
}
