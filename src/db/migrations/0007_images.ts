import type { Migration } from "../../types.js";

/**
 * Pictures of group messages, kept so the agent can look at and re-send them after the QQ URL expired.
 * `images`: one row per distinct picture (sha256 of the bytes); `message_images`: which message of which group carried it.
 * A group may only use pictures that have a `message_images` row of its own group.
 */
export const m0007: Migration = {
  version: 7,
  name: "images",
  up(db) {
    db.run(`CREATE TABLE images (
      id        INTEGER PRIMARY KEY,
      sha256    TEXT NOT NULL UNIQUE,
      mime      TEXT NOT NULL,
      data      BLOB NOT NULL,
      size      INTEGER NOT NULL,
      last_used INTEGER NOT NULL  -- unix seconds; the eviction order
    )`);
    db.run(`CREATE TABLE message_images (
      platform   TEXT NOT NULL,
      group_id   TEXT NOT NULL,
      message_id TEXT NOT NULL,
      idx        INTEGER NOT NULL,  -- position among the message's pictures
      image_id   INTEGER NOT NULL,
      PRIMARY KEY (platform, group_id, message_id, idx)
    ) WITHOUT ROWID`);
    db.run("CREATE INDEX message_images_image ON message_images (image_id)");
    db.run("CREATE INDEX message_images_group_image ON message_images (group_id, image_id)");
  },
};
