import type { Migration } from "../../types.js";

/**
 * The agent's filesystem as one table. Paths are absolute and normalised ("/a/b.txt", never a trailing
 * slash); "/" itself is implicit. Directories are rows too, so empty directories survive.
 * Parent/child integrity is enforced by VirtualFs inside transactions.
 */
export const m0003: Migration = {
  version: 3,
  name: "files",
  up(db) {
    db.run(`CREATE TABLE files (
      path    TEXT PRIMARY KEY,
      kind    TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
      content BLOB,
      size    INTEGER NOT NULL DEFAULT 0,
      mtime   INTEGER NOT NULL,  -- unix seconds
      CHECK ((kind = 'file') = (content IS NOT NULL)),
      CHECK (path LIKE '/%' AND path != '/' AND path NOT LIKE '%/')
    ) WITHOUT ROWID`);
  },
};
