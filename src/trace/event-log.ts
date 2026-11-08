import { noopLogger } from "../logger.js";
import type { EventLog, Logger, TraceConfig } from "../types.js";
import { RotatingFile } from "./rotating-file.js";

/** Bump when a field changes meaning; consumers can branch on `v`. */
export const EVENT_SCHEMA_VERSION = 1;

const MAX_STRING = 2000;
const MAX_ITEMS = 50;
const MAX_DEPTH = 5;

/** Drops everything the event log must not choke on: cycles, bigints, huge strings/arrays, Errors, functions. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING} chars)` : value;
  if (typeof value === "bigint") return value.toString();
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (depth >= MAX_DEPTH) return "[too deep]";
  if (value instanceof Error) return { name: value.name, message: sanitize(value.message, depth + 1) };
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => sanitize(v, depth + 1) ?? null);
    return value.length > MAX_ITEMS ? [...items, `…(+${value.length - MAX_ITEMS} items)`] : items;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      if (n++ >= MAX_ITEMS) {
        out["…"] = "more keys";
        break;
      }
      const s = sanitize(v, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;
}

/** A clipped copy of `text` if content capture is on, else undefined (so `{ text: preview(...) }` simply vanishes from the JSON). */
export function preview(events: EventLog, text: string, max = 500): string | undefined {
  if (!events.captureContent) return undefined;
  return text.length > max ? `${text.slice(0, max)}…(+${text.length - max} chars)` : text;
}

/** Records nothing; the default for components built without an event log. */
export const noopEventLog: EventLog = {
  emit() {},
  child: () => noopEventLog,
  captureContent: false,
};

export interface LineSink {
  write(line: string): void;
}

interface Core {
  sink: LineSink;
  seq: number;
  /** Identifies this process run: events of different runs interleave in rotated files. */
  boot: string;
  captureContent: boolean;
  clock: () => number;
  onError: (err: unknown) => void;
}

/**
 * One JSON object per line: `{ v, t, seq, boot, ev, ...bound, ...data }`. `seq` increases by one per event within
 * a process (gaps in a file mean lost events), `boot` tells processes apart, `t` is UTC ISO-8601.
 */
export class JsonlEventLog implements EventLog {
  private constructor(
    private readonly core: Core,
    private readonly bound: Record<string, unknown>,
  ) {}

  static create(sink: LineSink, o: { captureContent: boolean; boot?: string; clock?: () => number; onError?: (err: unknown) => void }): JsonlEventLog {
    return new JsonlEventLog(
      { sink, seq: 0, boot: o.boot ?? Math.random().toString(36).slice(2, 8), captureContent: o.captureContent, clock: o.clock ?? Date.now, onError: o.onError ?? (() => {}) },
      {},
    );
  }

  get captureContent(): boolean {
    return this.core.captureContent;
  }

  child(bound: Record<string, unknown>): EventLog {
    return new JsonlEventLog(this.core, { ...this.bound, ...(sanitize(bound) as Record<string, unknown>) });
  }

  emit(event: string, data: Record<string, unknown> = {}): void {
    try {
      const c = this.core;
      const record = { v: EVENT_SCHEMA_VERSION, t: new Date(c.clock()).toISOString(), seq: ++c.seq, boot: c.boot, ev: event, ...this.bound, ...(sanitize(data) as Record<string, unknown>) };
      c.sink.write(`${JSON.stringify(record)}\n`);
    } catch (err) {
      this.core.onError(err);
    }
  }
}

/**
 * The event log the entry points use: a rotating JSONL file under `TRACE_DIR`, or nothing when disabled.
 * A directory that cannot be created or written is a warning, never a reason to stop the bot.
 */
export function createEventLog(cfg: TraceConfig, logger: Logger = noopLogger): EventLog {
  if (!cfg.enabled) return noopEventLog;
  const log = logger.withTag("trace");
  let file: RotatingFile;
  try {
    file = new RotatingFile({ dir: cfg.dir, name: "agent", maxBytes: cfg.maxFileBytes, maxFiles: cfg.maxFiles, maxAgeDays: cfg.maxAgeDays, compress: cfg.compress });
  } catch (err) {
    log.warn(`event log disabled, cannot use ${cfg.dir}: ${err instanceof Error ? err.message : String(err)}`);
    return noopEventLog;
  }
  let lastWarn = 0;
  let dropped = 0;
  return JsonlEventLog.create(file, {
    captureContent: cfg.content,
    onError(err) {
      dropped++;
      const now = Date.now();
      if (now - lastWarn < 60_000) return; // one warning a minute is enough
      lastWarn = now;
      log.warn(`could not write the event log (${dropped} event(s) lost so far): ${err instanceof Error ? err.message : String(err)}`);
    },
  });
}
