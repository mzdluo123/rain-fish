import type { Migration } from "../../types.js";

/** Metadata is per receipt; original bytes live only once in the existing VFS tree. */
export const m0010: Migration = {
  version: 10,
  name: "uploads",
  up(db) {
    db.run(`CREATE TABLE vfs_files (
      id INTEGER PRIMARY KEY,
      platform TEXT NOT NULL,
      group_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      uploader_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER,
      sha256 TEXT,
      mime TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'queued', 'stored', 'too_large', 'failed')),
      consent INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      UNIQUE (platform, group_id, source_message_id, idx),
      CHECK (path GLOB '/uploads/*')
    )`);
    db.run("CREATE INDEX vfs_files_sha ON vfs_files (sha256, state)");
    db.run("CREATE INDEX vfs_files_group_path ON vfs_files (group_id, path, state)");
    db.run("CREATE INDEX vfs_files_group_time ON vfs_files (group_id, created_at)");
    db.run("ALTER TABLE messages ADD COLUMN file_ids TEXT NOT NULL DEFAULT '[]'");
  },
};
