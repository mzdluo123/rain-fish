import type { Database } from "bun:sqlite";

/** Persists, per group, the runs counted since the last must-speak notice (see `PiResponder`). */
export class SpeakStore {
  constructor(private readonly db: Database) {}

  load(groupId: string): number {
    const row = this.db.query("SELECT runs FROM speak_state WHERE group_id = ?").get(groupId) as { runs: number } | null;
    return row?.runs ?? 0;
  }

  save(groupId: string, runs: number): void {
    this.db.query("INSERT INTO speak_state (group_id, runs) VALUES (?, ?) ON CONFLICT (group_id) DO UPDATE SET runs = excluded.runs").run(groupId, runs);
  }
}
