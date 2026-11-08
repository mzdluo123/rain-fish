import type { Migration } from "../../types.js";

/**
 * State that used to live only in memory and was lost on restart.
 * `pending_messages`: group messages queued for the agent's next wake-up (JSON `GroupMessage` + whether it is
 *   addressed to the bot). Rows are removed only after the run that consumed them has finished, so a crash
 *   mid-run replays the batch instead of losing it.
 * `conversation_flags`: whether the memory flush already ran in the group's current compaction cycle.
 */
export const m0005: Migration = {
  version: 5,
  name: "restart_state",
  up(db) {
    db.run(`CREATE TABLE pending_messages (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id   TEXT NOT NULL,
      message_id TEXT NOT NULL,
      addressed  INTEGER NOT NULL,
      payload    TEXT NOT NULL,
      UNIQUE (group_id, message_id)
    )`);
    db.run(`CREATE TABLE conversation_flags (
      group_id TEXT PRIMARY KEY,
      flushed  INTEGER NOT NULL
    ) WITHOUT ROWID`);
  },
};
