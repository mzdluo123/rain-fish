import type { Database } from "bun:sqlite";
import type { ColabRuntimeRow } from "./types.js";

/** Persists the one Colab session this program may own (see `ColabRunner`). Times are ms since the epoch. */
export class ColabStore {
  constructor(private readonly db: Database) {}

  load(): ColabRuntimeRow | undefined {
    const row = this.db.query("SELECT name, state, created_at, last_used_at FROM colab_runtime WHERE id = 1").get() as
      | { name: string; state: ColabRuntimeRow["state"]; created_at: number; last_used_at: number }
      | null;
    return row ? { name: row.name, state: row.state, createdAt: row.created_at, lastUsedAt: row.last_used_at } : undefined;
  }

  save(row: ColabRuntimeRow): void {
    this.db
      .query(
        "INSERT INTO colab_runtime (id, name, state, created_at, last_used_at) VALUES (1, ?, ?, ?, ?) " +
          "ON CONFLICT (id) DO UPDATE SET name = excluded.name, state = excluded.state, created_at = excluded.created_at, last_used_at = excluded.last_used_at",
      )
      .run(row.name, row.state, row.createdAt, row.lastUsedAt);
  }

  touch(at: number): void {
    this.db.query("UPDATE colab_runtime SET last_used_at = ? WHERE id = 1").run(at);
  }

  clear(): void {
    this.db.run("DELETE FROM colab_runtime");
  }
}
