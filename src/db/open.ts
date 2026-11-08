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
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  migrate(db, migrations);
  return db;
}
