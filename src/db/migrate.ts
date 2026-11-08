import type { Database } from "bun:sqlite";
import type { AppliedMigration, Migration } from "../types.js";

/**
 * Forward-only migrator. Applied versions are recorded in `schema_migrations`.
 * Each migration runs in its own `BEGIN IMMEDIATE` transaction, so concurrent
 * processes (ingest + agent) serialise and never apply the same migration twice.
 * Returns the versions applied by this call.
 */
export function migrate(db: Database, migrations: readonly Migration[]): number[] {
  assertValid(migrations);
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const known = new Set(migrations.map((m) => m.version));
  const applied = db.query("SELECT version, name FROM schema_migrations ORDER BY version").all() as AppliedMigration[];
  const unknown = applied.find((a) => !known.has(a.version));
  if (unknown) {
    throw new Error(
      `Database has migration ${unknown.version} (${unknown.name}) that this code does not know; the database is newer than the application`,
    );
  }
  const latest = applied.at(-1)?.version ?? 0;
  const gap = migrations.find((m) => m.version < latest && !applied.some((a) => a.version === m.version));
  if (gap) {
    throw new Error(`Migration ${gap.version} (${gap.name}) is unapplied but a later one (${latest}) already is`);
  }

  const done: number[] = [];
  for (const m of migrations) {
    const run = db.transaction(() => {
      // Re-check under the write lock: another process may have applied it meanwhile.
      if (db.query("SELECT 1 FROM schema_migrations WHERE version = ?").get(m.version)) return false;
      m.up(db);
      db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        Math.floor(Date.now() / 1000),
      );
      return true;
    });
    if (run.immediate()) done.push(m.version);
  }
  return done;
}

function assertValid(migrations: readonly Migration[]): void {
  let prev = 0;
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= prev) {
      throw new Error(`Migration versions must be strictly increasing positive integers (got ${m.version} after ${prev})`);
    }
    prev = m.version;
  }
}
