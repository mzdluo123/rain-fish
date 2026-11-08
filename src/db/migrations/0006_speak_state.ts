import type { Migration } from "../../types.js";

/**
 * `speak_state`: per group, how many successful agent runs have passed since the last "you must say something" notice,
 * so the every-N-runs rhythm survives a restart.
 */
export const m0006: Migration = {
  version: 6,
  name: "speak_state",
  up(db) {
    db.run(`CREATE TABLE speak_state (
      group_id TEXT PRIMARY KEY,
      runs     INTEGER NOT NULL
    ) WITHOUT ROWID`);
  },
};
