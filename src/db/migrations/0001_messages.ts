import type { Migration } from "../../types.js";

export const m0001: Migration = {
  version: 1,
  name: "messages",
  up(db) {
    db.run(`CREATE TABLE messages (
      id         INTEGER PRIMARY KEY,
      platform   TEXT NOT NULL,
      group_id   TEXT NOT NULL,
      message_id TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      nickname   TEXT NOT NULL,
      ts         INTEGER NOT NULL,  -- unix seconds
      text       TEXT NOT NULL,
      UNIQUE (platform, group_id, message_id)
    )`);
    db.run("CREATE INDEX messages_group_ts ON messages (group_id, ts)");
    db.run("CREATE INDEX messages_user_ts ON messages (user_id, ts)");
  },
};
