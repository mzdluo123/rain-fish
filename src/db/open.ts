import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { migrate } from "./migrate.js";
import { migrations } from "./migrations/index.js";

/**
 * Opens the single SQLite file that holds all bot state (messages, virtual filesystem, ...)
 * and applies pending migrations. `dbPath` may be ":memory:".
 */
export function openDb(dbPath: string): Database {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath, { create: true, strict: true });
  enableIncrementalVacuum(db); // before WAL: once the file has a header, a new file can no longer take the setting
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  migrate(db, migrations);
  return db;
}

/**
 * Deleting rows (evicted pictures) only moves pages to SQLite's free list; the file never shrinks by itself. With
 * `auto_vacuum = INCREMENTAL` the store can hand free pages back (`PRAGMA incremental_vacuum`). The mode is fixed when the
 * file is created; a file made before that is converted once with a `VACUUM`.
 */
function enableIncrementalVacuum(db: Database): void {
  const mode = () => (db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum;
  if (mode() === 2) return;
  db.run("PRAGMA auto_vacuum = INCREMENTAL");
  const pages = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
  if (pages > 0) db.run("VACUUM"); // an existing database: rewrite it once so the setting takes effect
}
