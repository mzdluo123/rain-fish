import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEventLog, JsonlEventLog, noopEventLog, preview, sanitize } from "../src/trace/event-log.js";
import { RotatingFile, type RotationOptions } from "../src/trace/rotating-file.js";
import type { TraceConfig } from "../src/types.js";
import { memoryEventLog, recordingLogger } from "./helpers.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "trace-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A controllable clock starting at noon today, so "the same day" is robust. */
function clock() {
  const t = new Date();
  t.setHours(12, 0, 0, 0);
  return { now: () => new Date(t), advance: (ms: number) => void t.setTime(t.getTime() + ms) };
}
const files = (dir: string) => readdirSync(dir).sort();

function rotating(dir: string, over: Partial<RotationOptions> = {}) {
  const c = clock();
  const file = new RotatingFile({ dir, name: "agent", maxBytes: 1000, maxFiles: 10, maxAgeDays: 30, compress: false, now: c.now, ...over });
  return { file, c };
}

describe("RotatingFile: size", () => {
  it("appends to agent.jsonl and rotates before a write that would pass the limit, never splitting a line", () => {
    const dir = tmp();
    const { file, c } = rotating(dir, { maxBytes: 100 });
    const line = (n: number) => `${String(n).repeat(39)}\n`; // 40 bytes
    file.write(line(1));
    file.write(line(2));
    expect(files(dir)).toEqual(["agent.jsonl"]);
    c.advance(1000);
    file.write(line(3)); // 80 + 40 > 100 -> rotate first
    const [rotated] = file.rotated();
    expect(path.basename(rotated!)).toMatch(/^agent\.\d{8}-\d{6}\.jsonl$/);
    expect(readFileSync(rotated!, "utf-8")).toBe(line(1) + line(2));
    expect(readFileSync(file.livePath, "utf-8")).toBe(line(3));
  });

  it("writes a line bigger than the limit into an empty file instead of rotating forever", () => {
    const dir = tmp();
    const { file } = rotating(dir, { maxBytes: 10 });
    file.write(`${"x".repeat(50)}\n`);
    expect(file.rotated()).toEqual([]);
    expect(statSync(file.livePath).size).toBe(51);
  });

  it("gives colliding rotation times distinct names", () => {
    const dir = tmp();
    const { file } = rotating(dir, { maxBytes: 10 }); // clock never advances: every rotation has the same second
    for (let i = 0; i < 4; i++) file.write(`${"y".repeat(20)}\n`);
    expect(file.rotated()).toHaveLength(3);
    expect(new Set(file.rotated()).size).toBe(3);
  });
});

describe("RotatingFile: day", () => {
  it("starts a new file when the local date changes", () => {
    const dir = tmp();
    const { file, c } = rotating(dir);
    file.write("monday\n");
    c.advance(24 * 3600_000);
    file.write("tuesday\n");
    expect(readFileSync(file.rotated()[0]!, "utf-8")).toBe("monday\n");
    expect(readFileSync(file.livePath, "utf-8")).toBe("tuesday\n");
  });

  it("after a restart, keeps appending to today's file but rotates one last written on an earlier day", () => {
    const dir = tmp();
    const first = rotating(dir);
    first.file.write("a\n");
    const same = rotating(dir); // "restart" on the same day
    same.file.write("b\n");
    expect(readFileSync(same.file.livePath, "utf-8")).toBe("a\nb\n");
    expect(same.file.rotated()).toEqual([]);

    const yesterday = new Date(Date.now() - 36 * 3600_000);
    utimesSync(same.file.livePath, yesterday, yesterday);
    const next = rotating(dir);
    next.file.write("c\n");
    expect(readFileSync(next.file.rotated()[0]!, "utf-8")).toBe("a\nb\n");
    expect(readFileSync(next.file.livePath, "utf-8")).toBe("c\n");
  });
});

describe("RotatingFile: compression", () => {
  it("gzips rotated files, keeps their content and last-write time, and removes the plain copy", () => {
    const dir = tmp();
    const { file, c } = rotating(dir, { maxBytes: 100, compress: true });
    const content = `${"z".repeat(60)}\n`;
    file.write(content);
    const before = statSync(file.livePath).mtimeMs;
    c.advance(1000);
    file.write(content); // rotates the first
    const [gz] = file.rotated();
    expect(gz).toMatch(/\.jsonl\.gz$/);
    expect(Buffer.from(Bun.gunzipSync(readFileSync(gz!))).toString("utf-8")).toBe(content);
    expect(Math.abs(statSync(gz!).mtimeMs - before)).toBeLessThan(1500);
    expect(files(dir).filter((f) => f.endsWith(".jsonl") && f !== "agent.jsonl")).toEqual([]);
    expect(files(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});

describe("RotatingFile: retention", () => {
  it("keeps only the newest maxFiles rotated files and never touches the live file", () => {
    const dir = tmp();
    const { file, c } = rotating(dir, { maxBytes: 10, maxFiles: 2 });
    for (let i = 1; i <= 6; i++) {
      c.advance(60_000);
      file.write(`${String(i).repeat(20)}\n`);
    }
    const kept = file.rotated().map((f) => readFileSync(f, "utf-8"));
    expect(kept).toEqual([`${"5".repeat(20)}\n`, `${"4".repeat(20)}\n`]); // newest first
    expect(readFileSync(file.livePath, "utf-8")).toBe(`${"6".repeat(20)}\n`);
  });

  it("deletes rotated files whose last write is older than maxAgeDays, at startup and on rotation", () => {
    const dir = tmp();
    const old = path.join(dir, "agent.20200101-000000.jsonl");
    const recent = path.join(dir, "agent.20991231-000000.jsonl.gz");
    const other = path.join(dir, "notes.txt");
    writeFileSync(old, "o");
    writeFileSync(recent, "r");
    writeFileSync(other, "x");
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(old, longAgo, longAgo);
    utimesSync(other, longAgo, longAgo);
    rotating(dir, { maxAgeDays: 14 });
    expect(files(dir)).toEqual(["agent.20991231-000000.jsonl.gz", "notes.txt"]); // unrelated files are never pruned
  });
});

describe("RotatingFile: robustness", () => {
  it("recreates the directory if it disappears while running", () => {
    const dir = tmp();
    const { file } = rotating(dir);
    file.write("a\n");
    rmSync(dir, { recursive: true });
    file.write("b\n");
    expect(readFileSync(file.livePath, "utf-8")).toBe("b\n");
  });

  it("creates missing parent directories", () => {
    const dir = path.join(tmp(), "a", "b");
    rotating(dir).file.write("x\n");
    expect(existsSync(path.join(dir, "agent.jsonl"))).toBe(true);
  });
});

describe("JsonlEventLog", () => {
  it("writes one JSON object per line with version, UTC time, a gapless seq, the boot id and the event name", () => {
    const lines: string[] = [];
    const log = JsonlEventLog.create({ write: (l) => void lines.push(l) }, { captureContent: false, boot: "b1", clock: () => Date.parse("2026-11-08T12:00:00Z") });
    log.emit("a.b", { x: 1 });
    log.emit("c.d");
    expect(lines.every((l) => l.endsWith("\n") && !l.slice(0, -1).includes("\n"))).toBe(true);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { v: 1, t: "2026-11-08T12:00:00.000Z", seq: 1, boot: "b1", ev: "a.b", x: 1 },
      { v: 1, t: "2026-11-08T12:00:00.000Z", seq: 2, boot: "b1", ev: "c.d" },
    ]);
  });

  it("child() binds fields to every event, shares the sequence, and explicit data wins over bound fields", () => {
    const m = memoryEventLog();
    const g = m.events.child({ group: "100" });
    const r = g.child({ run: "r1" });
    g.emit("one");
    r.emit("two", { group: "override" });
    m.events.emit("three");
    expect(m.records().map((x) => [x.seq, x.ev, x.group, x.run])).toEqual([
      [1, "one", "100", undefined],
      [2, "two", "override", "r1"],
      [3, "three", undefined, undefined],
    ]);
  });

  it("never throws: a failing sink is reported once per failure and the program carries on", () => {
    const errors: unknown[] = [];
    const log = JsonlEventLog.create({ write: () => { throw new Error("disk full"); } }, { captureContent: false, onError: (e) => errors.push(e) });
    expect(() => log.emit("x")).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it("clips and neutralises data that cannot be written as is", () => {
    const m = memoryEventLog();
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    m.events.emit("odd", { big: "x".repeat(5000), n: 10n, err: new Error("boom"), fn: () => 1, undef: undefined, circular, many: Array.from({ length: 80 }, (_, i) => i) });
    const [r] = m.records();
    expect(r!.big.length).toBeLessThan(2100);
    expect(r!.big).toContain("+3000 chars");
    expect(r!.n).toBe("10");
    expect(r!.err).toEqual({ name: "Error", message: "boom" });
    expect("fn" in r!).toBe(false);
    expect(r!.circular.self.self.self.self).toBe("[too deep]");
    expect(r!.many).toHaveLength(51);
  });

  it("sanitize keeps plain JSON as is", () => {
    expect(sanitize({ a: [1, "b", null, { c: true }] })).toEqual({ a: [1, "b", null, { c: true }] });
  });

  it("preview() yields text only when content capture is on", () => {
    expect(preview(memoryEventLog().events, "secret")).toBeUndefined();
    const on = memoryEventLog({ captureContent: true }).events;
    expect(preview(on, "secret")).toBe("secret");
    expect(preview(on, "x".repeat(600))).toContain("+100 chars");
  });

  it("the no-op log accepts everything and records nothing", () => {
    expect(() => noopEventLog.child({ a: 1 }).emit("x", { y: 1 })).not.toThrow();
  });
});

describe("createEventLog", () => {
  const cfg = (dir: string, over: Partial<TraceConfig> = {}): TraceConfig => ({ enabled: true, dir, maxFileBytes: 1_000_000, maxFiles: 5, maxAgeDays: 7, compress: false, content: false, ...over });

  it("writes JSONL under the configured directory", () => {
    const dir = path.join(tmp(), "logs");
    const log = createEventLog(cfg(dir));
    log.emit("hello", { n: 1 });
    const rec = JSON.parse(readFileSync(path.join(dir, "agent.jsonl"), "utf-8"));
    expect(rec).toMatchObject({ ev: "hello", n: 1, v: 1 });
  });

  it("does nothing, and creates nothing, when disabled", () => {
    const dir = path.join(tmp(), "logs");
    createEventLog(cfg(dir, { enabled: false })).emit("x");
    expect(existsSync(dir)).toBe(false);
  });

  it("an unusable directory is a warning, not a startup failure", () => {
    const file = path.join(tmp(), "a-file");
    writeFileSync(file, "x");
    const rec = recordingLogger();
    const log = createEventLog(cfg(path.join(file, "logs")), rec.logger);
    expect(() => log.emit("x")).not.toThrow();
    expect(rec.entries.some((e) => e.level === "warn" && e.msg.includes("event log disabled"))).toBe(true);
  });

  it("content capture follows the config", () => {
    expect(createEventLog(cfg(tmp(), { content: true })).captureContent).toBe(true);
    expect(createEventLog(cfg(tmp())).captureContent).toBe(false);
  });
});
