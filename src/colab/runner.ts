import { randomUUID } from "node:crypto";
import type { ColabStore } from "../colab-store.js";
import { noopLogger } from "../logger.js";
import { noopEventLog } from "../trace/event-log.js";
import type { CliResult, ColabCli, ColabConfig, EventLog, Logger, PythonRunRequest, PythonRunResult } from "../types.js";
import { buildPayload, parseResult } from "./payload.js";

/** Extra seconds the CLI may wait beyond the script's own limit (upload, kernel start, result); then the local kill backs it up. */
const EXEC_GRACE_SECONDS = 60;
const STOP_TIMEOUT_MS = 60_000;
const RESTART_TIMEOUT_MS = 60_000;
const HOUR_MS = 3_600_000;

type RunnerConfig = Pick<ColabConfig, "auth" | "sessionName" | "idleMs" | "createTimeoutMs" | "outputMaxBytes" | "maxPerHour" | "env">;

export interface ColabRunnerOptions {
  cli: ColabCli;
  store: ColabStore;
  config: RunnerConfig;
  logger?: Logger;
  events?: EventLog;
  now?: () => number;
  /** The idle clock (tests drive it by hand). Default: `setTimeout`, unref'd so it never keeps the process alive. */
  timer?: IdleTimer;
}

export interface IdleTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimer: IdleTimer = {
  set: (fn, ms) => setTimeout(fn, ms).unref(),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const tailOf = (r: CliResult) => `${r.stderr}\n${r.stdout}`.trim().slice(-500);

/**
 * The one Colab CPU runtime of this program, shared by all groups. It is created by the first run (`colab new`), every run is
 * executed through it one at a time (a single queue: runs, the idle stop and the startup clean-up never overlap), and it is released
 * (`colab stop`) once nothing has run for `idleMs`. The row in `colab_runtime` is written BEFORE `colab new`, so a crash at any point
 * leaves a record: `restore()` at the next start reuses a runtime that is still fresh and releases anything else.
 */
export class ColabRunner {
  private ready = false;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private idleTimer?: unknown;
  private readonly recent: number[] = [];
  private readonly log: Logger;
  private readonly events: EventLog;
  private readonly now: () => number;
  private readonly timer: IdleTimer;

  constructor(private readonly o: ColabRunnerOptions) {
    this.log = (o.logger ?? noopLogger).withTag("colab");
    this.events = o.events ?? noopEventLog;
    this.now = o.now ?? Date.now;
    this.timer = o.timer ?? realTimer;
  }

  /** At startup: a runtime recorded by the last process is reused if it was used within `idleMs`, otherwise released. */
  restore(): Promise<void> {
    const row = this.o.store.load();
    if (!row) return Promise.resolve();
    const idleFor = this.now() - row.lastUsedAt;
    if (row.state === "ready" && idleFor < this.o.config.idleMs) {
      this.ready = true;
      this.setState("ready", "restored");
      this.armIdle(this.o.config.idleMs - idleFor);
      return Promise.resolve();
    }
    return this.enqueue(() => this.release("startup_stale"));
  }

  /** Runs one file (queued behind any other run). Throws when it could not be run; a script that fails is a normal result. */
  run(req: PythonRunRequest): Promise<PythonRunResult> {
    const now = this.now();
    while (this.recent.length > 0 && this.recent[0]! <= now - HOUR_MS) this.recent.shift();
    if (this.recent.length >= this.o.config.maxPerHour) {
      throw new Error(`Rate limit: at most ${this.o.config.maxPerHour} Python runs per hour (all groups together). Try again later.`);
    }
    this.recent.push(now);
    this.pending++;
    this.clearIdle();
    return this.enqueue(() => this.execute(req)).finally(() => {
      this.pending--;
      if (this.pending === 0 && this.ready) this.armIdle(this.o.config.idleMs);
    });
  }

  /** Releases the runtime now (console command). Queued behind a run in progress. */
  stop(reason: string): Promise<void> {
    this.clearIdle();
    return this.enqueue(() => this.release(reason));
  }

  /** On process exit: releases the runtime without waiting for a run in progress (the process is going away anyway). */
  async shutdown(): Promise<void> {
    this.clearIdle();
    if (this.o.store.load()) await this.release("shutdown");
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const p = this.tail.then(job);
    this.tail = p.catch(() => undefined);
    return p;
  }

  private async execute(req: PythonRunRequest): Promise<PythonRunResult> {
    if (req.signal?.aborted) throw new Error("Aborted before the run started.");
    await this.ensureReady();
    let out = await this.exec(req);
    if (!out.ok) {
      // No result line: the kernel never ran the payload (the runtime was reclaimed by Colab, the session is gone, ...). One fresh start.
      this.log.warn(`no result from ${this.name()} (${out.detail.slice(-200)}); recreating it once`);
      await this.release("lost");
      await this.ensureReady();
      out = await this.exec(req);
      if (!out.ok) throw new Error(`Colab did not run the file: ${out.detail}`);
    }
    this.o.store.touch(this.now());
    return out.result;
  }

  private async exec(req: PythonRunRequest): Promise<{ ok: true; result: PythonRunResult } | { ok: false; detail: string }> {
    const marker = `__rain_fish_result_${randomUUID()}__`;
    const code = buildPayload({ name: req.name, source: req.source, args: req.args, env: this.o.config.env, timeoutSeconds: req.timeoutSeconds, maxBytes: req.maxOutputBytes ?? this.o.config.outputMaxBytes, marker });
    const started = this.now();
    // `--timeout` of `colab exec` is an idle limit (seconds without output); the launcher prints only at the end.
    const idle = req.timeoutSeconds + EXEC_GRACE_SECONDS;
    const r = await this.o.cli.run([...this.global(), "exec", "-s", this.name(), "--timeout", String(idle)], { stdin: code, timeoutMs: (idle + EXEC_GRACE_SECONDS) * 1000, signal: req.signal });
    if (r.aborted || r.timedOut) {
      // Killing the CLI does not stop the kernel: restart it so the next run does not queue behind this one.
      await this.restartKernel();
      throw new Error(r.aborted ? "The run was aborted." : `No result from Colab within ${idle + EXEC_GRACE_SECONDS}s; the kernel was restarted.`);
    }
    const parsed = parseResult(r.stdout, marker);
    if (parsed === undefined) return { ok: false, detail: `exit ${r.code}: ${tailOf(r)}` };
    if ("error" in parsed) throw new Error(`The remote launcher failed: ${parsed.error}`);
    const res = this.mask(parsed.ok);
    this.log.debug(`${req.group ? `group ${req.group}: ` : ""}${req.name}: exit ${res.exitCode}${res.timedOut ? " (timed out)" : ""} in ${res.durationMs}ms`);
    this.events.emit("colab.exec", {
      group: req.group,
      call_id: req.callId,
      exit_code: res.exitCode,
      timed_out: res.timedOut,
      duration_ms: res.durationMs,
      wall_ms: this.now() - started,
      source_bytes: Buffer.byteLength(req.source, "utf-8"),
      args_count: req.args.length,
      stdout_bytes: res.stdout.bytes,
      stderr_bytes: res.stderr.bytes,
    });
    return { ok: true, result: res };
  }

  /** The secrets handed to the script must never come back to the model (a script could print its environment): they are masked in both streams. */
  private mask(r: PythonRunResult): PythonRunResult {
    const secrets = Object.values(this.o.config.env).filter((s) => s.length > 0);
    if (secrets.length === 0) return r;
    const hide = (s: string) => secrets.reduce((t, v) => t.split(v).join("[REDACTED]"), s);
    return { ...r, stdout: { ...r.stdout, head: hide(r.stdout.head), tail: hide(r.stdout.tail) }, stderr: { ...r.stderr, head: hide(r.stderr.head), tail: hide(r.stderr.tail) } };
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    if (this.o.store.load()) await this.release("replace"); // something may still be assigned under the recorded name
    const name = this.o.config.sessionName;
    const at = this.now();
    this.o.store.save({ name, state: "creating", createdAt: at, lastUsedAt: at });
    this.setState("creating", "first_exec");
    this.log.info(`creating Colab CPU runtime ${name}`);
    const r = await this.o.cli.run([...this.global(), "new", "-s", name], { timeoutMs: this.o.config.createTimeoutMs });
    if (r.code !== 0 || r.timedOut) {
      const detail = r.timedOut ? `no answer within ${this.o.config.createTimeoutMs / 1000}s` : `exit ${r.code}: ${tailOf(r)}`;
      this.log.error(`could not create Colab runtime ${name}: ${detail}`);
      await this.release("create_failed"); // it may have been assigned before the failure
      throw new Error(`Could not start the Colab machine: ${detail}`);
    }
    this.o.store.save({ name, state: "ready", createdAt: at, lastUsedAt: this.now() });
    this.ready = true;
    this.setState("ready", "created");
    this.log.success(`Colab runtime ${name} is ready (${((this.now() - at) / 1000).toFixed(1)}s)`);
  }

  /** `colab stop` for the recorded session. The record is dropped even if that fails (logged): Colab reclaims idle runtimes itself. */
  private async release(reason: string): Promise<void> {
    const row = this.o.store.load();
    this.ready = false;
    if (!row) return;
    const r = await this.o.cli.run([...this.global(), "stop", "-s", row.name], { timeoutMs: STOP_TIMEOUT_MS });
    this.o.store.clear();
    this.setState("stopped", reason);
    if (r.code === 0 && !r.timedOut) this.log.info(`released Colab runtime ${row.name} (${reason})`);
    else this.log.warn(`colab stop ${row.name} (${reason}) failed: ${r.timedOut ? "timed out" : `exit ${r.code}: ${tailOf(r)}`}`);
  }

  private async restartKernel(): Promise<void> {
    const r = await this.o.cli.run([...this.global(), "restart-kernel", "-s", this.name()], { timeoutMs: RESTART_TIMEOUT_MS });
    if (r.code !== 0 || r.timedOut) this.log.warn(`colab restart-kernel failed: ${r.timedOut ? "timed out" : `exit ${r.code}: ${tailOf(r)}`}`);
  }

  private armIdle(ms: number): void {
    this.clearIdle();
    this.idleTimer = this.timer.set(() => {
      this.idleTimer = undefined;
      if (this.pending > 0) return;
      this.enqueue(() => this.release("idle")).catch((err) => this.log.error(`idle release failed: ${err instanceof Error ? err.message : String(err)}`));
    }, Math.max(0, ms));
  }

  private clearIdle(): void {
    this.timer.clear(this.idleTimer);
    this.idleTimer = undefined;
  }

  private name(): string {
    return this.o.store.load()?.name ?? this.o.config.sessionName;
  }

  private global(): string[] {
    return this.o.config.auth ? ["--auth", this.o.config.auth] : [];
  }

  private setState(state: "creating" | "ready" | "stopped", reason: string): void {
    this.events.emit("colab.state", { state, reason, session: this.o.config.sessionName });
  }
}
