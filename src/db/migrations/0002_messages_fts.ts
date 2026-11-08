import { tokenize } from "../tokenize.js";
import type { Migration } from "../../types.js";

/**
 * Inverted index over messages. `rowid` = messages.id; `tokens` holds the
 * pre-segmented text (space-joined) so the stock unicode61 tokenizer works for CJK.
 * Backfills existing rows, so the same pattern works for a future re-tokenisation migration.
 */
export const m0002: Migration = {
  version: 2,
  name: "messages_fts",
  up(db) {
    db.run("CREATE VIRTUAL TABLE messages_fts USING fts5(tokens, tokenize = 'unicode61 remove_diacritics 2')");
    const insert = db.query("INSERT INTO messages_fts (rowid, tokens) VALUES (?, ?)");
    for (const row of db.query("SELECT id, text FROM messages").all() as { id: number; text: string }[]) {
      insert.run(row.id, tokenize(row.text).join(" "));
    }
  },
};
