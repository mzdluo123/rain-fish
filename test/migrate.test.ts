import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { migrate } from "../src/db/migrate.js";
import type { Migration } from "../src/types.js";

const create = (version: number, table: string): Migration => ({
  version,
  name: table,
  up: (db) => void db.run(`CREATE TABLE ${table} (x INTEGER)`),
});
const tables = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

describe("migrate", () => {
  it("applies pending migrations once, in order, and records them", () => {
    const db = new Database(":memory:");
    const ms = [create(1, "a"), create(2, "b")];
    expect(migrate(db, ms)).toEqual([1, 2]);
    expect(migrate(db, ms)).toEqual([]);
    expect(tables(db)).toEqual(["a", "b", "schema_migrations"]);
  });

  it("applies only newer migrations when the code grows", () => {
    const db = new Database(":memory:");
    migrate(db, [create(1, "a")]);
    expect(migrate(db, [create(1, "a"), create(2, "b")])).toEqual([2]);
  });

  it("rolls a failing migration back completely and leaves it unapplied", () => {
    const db = new Database(":memory:");
    const bad: Migration = {
      version: 2,
      name: "bad",
      up(d) {
        d.run("CREATE TABLE half (x INTEGER)");
        throw new Error("boom");
      },
    };
    expect(() => migrate(db, [create(1, "a"), bad])).toThrow("boom");
    expect(tables(db)).toEqual(["a", "schema_migrations"]);
    expect(migrate(db, [create(1, "a"), create(2, "b")])).toEqual([2]);
  });

  it("refuses a database that is newer than the code", () => {
    const db = new Database(":memory:");
    migrate(db, [create(1, "a"), create(2, "b")]);
    expect(() => migrate(db, [create(1, "a")])).toThrow(/newer than the application/);
  });

  it("refuses a migration inserted before one already applied", () => {
    const db = new Database(":memory:");
    migrate(db, [create(1, "a"), create(3, "c")]);
    expect(() => migrate(db, [create(1, "a"), create(2, "b"), create(3, "c")])).toThrow(/unapplied/);
  });

  it("rejects duplicate or non-increasing versions before touching the db", () => {
    const db = new Database(":memory:");
    expect(() => migrate(db, [create(1, "a"), create(1, "b")])).toThrow(/strictly increasing/);
    expect(() => migrate(db, [create(2, "a"), create(1, "b")])).toThrow(/strictly increasing/);
    expect(tables(db)).toEqual([]);
  });

  it("two connections to one file never apply the same migration twice", () => {
    const path = `${require("node:os").tmpdir()}/mig-${crypto.randomUUID()}.db`;
    const a = new Database(path);
    const b = new Database(path);
    const ms = [create(1, "a"), create(2, "b")];
    migrate(a, ms);
    expect(migrate(b, ms)).toEqual([]);
  });
});
