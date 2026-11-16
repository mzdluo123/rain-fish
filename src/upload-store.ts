import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { FileRef, GroupMessage, StoredUpload, UploadQuery, UploadState } from "./types.js";
import { DEFAULT_VFS_LIMITS, VirtualFs } from "./vfs.js";

export const fileRef = (id: number): string => `f${id}`;
export function parseFileRef(s: string): number {
  if (!/^f[1-9]\d{0,14}$/.test(s) || !Number.isSafeInteger(Number(s.slice(1)))) throw new Error("Invalid file id; use f12.");
  return Number(s.slice(1));
}

/** A single bounded component. Slashes, dot traversal, controls and bidi formatting never survive. */
export function sanitizeUploadName(name: string): string {
  const clean = name.normalize("NFC").replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, "_").replace(/\.{2,}/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
  let out = "";
  for (const ch of clean) {
    if (Buffer.byteLength(out + ch) > 180) break;
    out += ch;
  }
  return out || "file";
}

export function uploadSummary(f: StoredUpload): string {
  const size = f.size === null ? "unknown size" : f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`;
  return `[文件: ${fileRef(f.id)} ${f.name} ${size}] ${f.path} (${f.state})`;
}

/** One row per receipt (consent belongs to the uploader), one VFS blob per distinct approved content. */
export class UploadStore {
  private readonly fs: VirtualFs;
  constructor(private readonly db: Database, readonly maxBytes = 1024 * 1024) {
    this.fs = new VirtualFs(db, { ...DEFAULT_VFS_LIMITS, maxFileBytes: maxBytes });
  }

  register(msg: GroupMessage, file: FileRef, idx: number, privacy: "ask" | "auto"): StoredUpload {
    const old = this.db.query("SELECT * FROM vfs_files WHERE platform = ? AND group_id = ? AND source_message_id = ? AND idx = ?").get(msg.platform, msg.groupId, msg.messageId, idx) as StoredUpload | null;
    if (old) return old;
    const name = sanitizeUploadName(file.name);
    const month = new Date(msg.ts * 1000).toISOString().slice(0, 7);
    const path = VirtualFs.normalize(`/uploads/${month}/${sanitizeUploadName(msg.messageId)}${idx ? `_${idx}` : ""}__${name}`);
    const state = file.size !== undefined && file.size > this.maxBytes ? "too_large" : privacy === "ask" ? "pending" : "queued";
    const r = this.db.query(`INSERT INTO vfs_files (platform, group_id, source_message_id, idx, uploader_id, name, path, size, mime, created_at, state, consent, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(msg.platform, msg.groupId, msg.messageId, idx, msg.userId, name, path, file.size ?? null, "application/octet-stream", msg.ts, state, privacy === "auto" ? 1 : 0, JSON.stringify(file));
    return this.get(msg.groupId, Number(r.lastInsertRowid))!;
  }

  get(groupId: string, id: number): StoredUpload | undefined {
    return (this.db.query("SELECT * FROM vfs_files WHERE group_id = ? AND id = ?").get(groupId, id) as StoredUpload | null) ?? undefined;
  }

  ofMessage(msg: Pick<GroupMessage, "platform" | "groupId" | "messageId">): StoredUpload[] {
    return this.db.query("SELECT * FROM vfs_files WHERE platform = ? AND group_id = ? AND source_message_id = ? ORDER BY idx").all(msg.platform, msg.groupId, msg.messageId) as StoredUpload[];
  }

  approve(groupId: string, id: number, uploaderId: string): boolean {
    return this.db.query("UPDATE vfs_files SET consent = 1, state = 'queued' WHERE group_id = ? AND id = ? AND uploader_id = ? AND state = 'pending'").run(groupId, id, uploaderId).changes > 0;
  }

  list(groupId: string, q: UploadQuery = {}): StoredUpload[] {
    const where = ["group_id = ?"];
    const args: (string | number)[] = [groupId];
    if (q.uploader !== undefined) { where.push("uploader_id = ?"); args.push(q.uploader); }
    if (q.since !== undefined) { where.push("created_at >= ?"); args.push(q.since); }
    if (q.until !== undefined) { where.push("created_at <= ?"); args.push(q.until); }
    args.push(Math.max(1, Math.min(50, Math.trunc(q.limit ?? 20))));
    return this.db.query(`SELECT * FROM vfs_files WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args) as StoredUpload[];
  }

  fail(groupId: string, id: number, state: Extract<UploadState, "failed" | "too_large">, size?: number): void {
    this.db.query("UPDATE vfs_files SET state = ?, size = COALESCE(?, size) WHERE group_id = ? AND id = ? AND state = 'queued'").run(state, size ?? null, groupId, id);
  }

  save(groupId: string, id: number, bytes: Buffer, mime: string): void {
    const sha = createHash("sha256").update(bytes).digest("hex");
    this.db.transaction(() => {
      const row = this.get(groupId, id);
      if (row?.state !== "queued" || !row.consent) return;
      if (bytes.length > this.maxBytes) { this.fail(groupId, id, "too_large", bytes.length); return; }
      const matches = this.db.query("SELECT DISTINCT path FROM vfs_files WHERE sha256 = ? AND state = 'stored'").all(sha) as { path: string }[];
      // Host-side import/delete may have changed a path; never reuse stale content.
      const existing = matches.find((m) => {
        try { return createHash("sha256").update(this.fs.readFile(m.path)).digest("hex") === sha; }
        catch { return false; }
      });
      let dest = existing?.path ?? row.path;
      if (!existing) {
        if (this.db.query("SELECT 1 FROM files WHERE path = ?").get(dest)) dest = VirtualFs.normalize(`/uploads/${new Date(row.created_at * 1000).toISOString().slice(0, 7)}/${fileRef(id)}__${row.name}`);
        this.fs.createFiles([{ path: dest, content: bytes }]);
      }
      this.db.query("UPDATE vfs_files SET path = ?, size = ?, sha256 = ?, mime = ?, state = 'stored' WHERE id = ?").run(dest, bytes.length, sha, mime, id);
    }).immediate();
  }
}
