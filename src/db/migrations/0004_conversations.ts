import type { Migration } from "../../types.js";

/**
 * Agent conversation state, so a restart resumes where it left off and compaction survives.
 * `agent_messages`: raw messages of the live (not yet archived) part, JSON, in order.
 * `agent_archives`: the compacted older part as serialized text; images are re-rendered from it.
 */
export const m0004: Migration = {
  version: 4,
  name: "conversations",
  up(db) {
    db.run(`CREATE TABLE agent_messages (
      group_id TEXT NOT NULL,
      seq      INTEGER NOT NULL,
      message  TEXT NOT NULL,
      PRIMARY KEY (group_id, seq)
    ) WITHOUT ROWID`);
    db.run(`CREATE TABLE agent_archives (
      group_id    TEXT PRIMARY KEY,
      through_seq INTEGER NOT NULL,
      source_text TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    ) WITHOUT ROWID`);
  },
};
