import type { Migration } from "../../types.js";

/**
 * `colab_runtime`: the one Google Colab session this program may have assigned (at most one row). Written before `colab new`
 * runs, so a crash mid-creation still leaves a record, and the next start releases (or, if still fresh, reuses) it.
 */
export const m0008: Migration = {
  version: 8,
  name: "colab_runtime",
  up(db) {
    db.run(`CREATE TABLE colab_runtime (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      name         TEXT NOT NULL,
      state        TEXT NOT NULL CHECK (state IN ('creating', 'ready')),
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    )`);
  },
};
