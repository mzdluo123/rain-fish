import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ColabStore } from "../src/colab-store.js";
import { ColabRunner, type IdleTimer } from "../src/colab/runner.js";
import { openDb } from "../src/db/open.js";
import type { CliResult, ColabCli, ColabConfig } from "../src/types.js";

const config: Pick<ColabConfig, "auth" | "sessionName" | "idleMs" | "createTimeoutMs" | "outputMaxBytes" | "maxPerHour" | "env"> = {
  auth: undefined,
  sessionName: "rf-test",
  idleMs: 60_000,
  createTimeoutMs: 1000,
  outputMaxBytes: 8000,
  maxPerHour: 100,
  env: {},
};
const ok = (over: Partial<CliResult> = {}): CliResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, aborted: false, ...over });
/** Lets every queued job (all fakes resolve without timers) run to the end. */
const settle = () => new Promise<void>((r) => setImmediate(r));
/** The idle clock, driven by hand: `fire()` runs what is armed. */
function manualTimer() {
  const armed = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  const timer: IdleTimer = { set: (fn, ms) => (armed.set(++next, { fn, ms }), next), clear: (h) => void armed.delete(h as number) };
  return { timer, armed, fire: () => [...armed.entries()].forEach(([id, t]) => (armed.delete(id), t.fn())) };
}

const packedSchema = z.object({ marker: z.string(), max_bytes: z.number(), args: z.array(z.string()), env: z.record(z.string(), z.string()) });
/** The arguments `buildPayload` packed into `stdin` (the code sent to the kernel). */
const packedArgs = (stdin: string) => packedSchema.parse(JSON.parse(Buffer.from(/__rain_fish_run\("([A-Za-z0-9+/=]+)"\)/.exec(stdin)![1]!, "base64").toString("utf-8")));

/** What the remote launcher would print for `stdin` (the payload): its result line, with `res` as the JSON. */
const resultLine = (stdin: string, res: unknown) => `[colab] some CLI chatter\n${packedArgs(stdin).marker}${JSON.stringify(res)}\n`;
const success = { exit_code: 0, timed_out: false, duration_ms: 7, stdout: { head: "hi\n", tail: "", bytes: 3 }, stderr: { head: "", tail: "", bytes: 0 } };

type Exec = (stdin: string, n: number) => Promise<CliResult> | CliResult;

function setup(o: { exec?: Exec; create?: () => CliResult; config?: Partial<typeof config>; now?: () => number } = {}) {
  const clock = manualTimer();
  const db = openDb(":memory:");
  const store = new ColabStore(db);
  const calls: string[][] = [];
  const statesAtCreate: (string | undefined)[] = [];
  let execs = 0;
  let active = 0;
  let maxActive = 0;
  const cli: ColabCli = {
    async run(args, opts) {
      calls.push([...args]);
      const sub = args.find((a) => ["new", "exec", "stop", "restart-kernel"].includes(a));
      if (sub === "new") {
        statesAtCreate.push(store.load()?.state);
        return o.create?.() ?? ok();
      }
      if (sub !== "exec") return ok();
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        for (let i = 0; i < 5; i++) await null; // stay "running" across a few ticks, so an overlapping exec would be seen
        return await (o.exec ?? ((stdin) => ok({ stdout: resultLine(stdin, success) })))(opts.stdin!, ++execs);
      } finally {
        active--;
      }
    },
  };
  const runner = new ColabRunner({ cli, store, config: { ...config, ...o.config }, now: o.now, timer: clock.timer });
  const subs = () => calls.map((c) => c.find((a) => ["new", "exec", "stop", "restart-kernel"].includes(a)));
  return { runner, store, calls, subs, statesAtCreate, maxActive: () => maxActive, clock };
}
const req = { name: "a.py", source: "print('hi')", args: [], timeoutSeconds: 10 };

describe("ColabRunner", () => {
  it("creates the runtime on the first run only, even when two runs start together, and runs them one at a time", async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.runner.run(req), t.runner.run(req)]);
    expect(a.stdout.head).toBe("hi\n");
    expect(b.exitCode).toBe(0);
    expect(t.subs()).toEqual(["new", "exec", "exec"]);
    expect(t.maxActive()).toBe(1);
    expect(t.calls[0]).toEqual(["new", "-s", "rf-test"]);
    expect(t.calls[1]).toEqual(["exec", "-s", "rf-test", "--timeout", "70"]); // idle limit = script limit + grace
    expect(t.statesAtCreate).toEqual(["creating"]); // recorded before `colab new`, so a crash mid-creation is cleaned up
    expect(t.store.load()?.state).toBe("ready");
  });

  it("sends the configured output limit, or the one the call asked for, and the call's arguments", async () => {
    const sent: { max_bytes: number; args: string[] }[] = [];
    const t = setup({
      exec: (stdin) => {
        sent.push(packedArgs(stdin));
        return ok({ stdout: resultLine(stdin, success) });
      },
    });
    await t.runner.run(req);
    await t.runner.run({ ...req, maxOutputBytes: 50_000, args: ["a b", "--x=$(rm -rf /)"] });
    expect(sent.map((s) => s.max_bytes)).toEqual([config.outputMaxBytes, 50_000]);
    expect(sent.map((s) => s.args)).toEqual([[], ["a b", "--x=$(rm -rf /)"]]);
  });

  it("hands configured secrets to the script as environment and masks them in what comes back to the agent", async () => {
    let env: Record<string, string> = {};
    const leaked = { ...success, stdout: { head: "key=sk-secret-123\n", tail: "end sk-secret-123", bytes: 40 }, stderr: { head: "sk-secret-123", tail: "", bytes: 13 } };
    const t = setup({
      config: { env: { TAVILY_API_KEY: "sk-secret-123" } },
      exec: (stdin) => {
        env = packedArgs(stdin).env;
        return ok({ stdout: resultLine(stdin, leaked) });
      },
    });
    const r = await t.runner.run({ ...req, args: ["query"] });
    expect(env).toEqual({ TAVILY_API_KEY: "sk-secret-123" });
    expect(JSON.stringify(r)).not.toContain("sk-secret-123");
    expect(r.stdout.head).toBe("key=[REDACTED]\n");
  });

  it("releases the runtime after the idle time and creates a new one for the next run", async () => {
    const t = setup({ config: { idleMs: 30_000 } });
    await t.runner.run(req);
    expect([...t.clock.armed.values()].map((a) => a.ms)).toEqual([30_000]);
    t.clock.fire();
    await settle();
    expect(t.subs()).toEqual(["new", "exec", "stop"]);
    expect(t.store.load()).toBeUndefined();
    await t.runner.run(req);
    expect(t.subs()).toEqual(["new", "exec", "stop", "new", "exec"]);
  });

  it("a run keeps the runtime alive: the idle clock is stopped while runs are queued and restarts after the last one", async () => {
    const t = setup();
    await t.runner.run(req);
    expect(t.clock.armed.size).toBe(1);
    const both = Promise.all([t.runner.run(req), t.runner.run(req)]);
    expect(t.clock.armed.size).toBe(0);
    await both;
    expect([...t.clock.armed.values()].map((a) => a.ms)).toEqual([config.idleMs]);
    expect(t.subs()).toEqual(["new", "exec", "exec", "exec"]);
  });

  it("no result line means the session is gone: it is released, recreated and the file runs once more", async () => {
    const t = setup({ exec: (stdin, n) => (n === 1 ? ok({ code: 1, stdout: "[colab] Session 'rf-test' appears to be lost (404/401). Cleaning up." }) : ok({ stdout: resultLine(stdin, success) })) });
    expect((await t.runner.run(req)).exitCode).toBe(0);
    expect(t.subs()).toEqual(["new", "exec", "stop", "new", "exec"]);
  });

  it("gives up after the one retry", async () => {
    const t = setup({ exec: () => ok({ code: 1, stderr: "boom" }) });
    await expect(t.runner.run(req)).rejects.toThrow(/did not run the file.*boom/);
    expect(t.subs()).toEqual(["new", "exec", "stop", "new", "exec"]);
  });

  it("a launcher failure is reported and not retried", async () => {
    const t = setup({ exec: (stdin) => ok({ stdout: resultLine(stdin, { error: "OSError('disk full')" }) }) });
    await expect(t.runner.run(req)).rejects.toThrow(/launcher failed: OSError/);
    expect(t.subs()).toEqual(["new", "exec"]);
  });

  it("a CLI killed locally (no answer in time) is followed by a kernel restart", async () => {
    const t = setup({ exec: () => ok({ code: null, timedOut: true }) });
    await expect(t.runner.run(req)).rejects.toThrow(/kernel was restarted/);
    expect(t.subs()).toEqual(["new", "exec", "restart-kernel"]);
  });

  it("a failed creation is an error, releases whatever may have been assigned, and the next run tries again", async () => {
    let n = 0;
    const t = setup({ create: () => (++n === 1 ? ok({ code: 1, stderr: "quota" }) : ok()) });
    await expect(t.runner.run(req)).rejects.toThrow(/Could not start the Colab machine.*quota/);
    expect(t.subs()).toEqual(["new", "stop"]);
    expect(t.store.load()).toBeUndefined();
    await t.runner.run(req);
    expect(t.subs()).toEqual(["new", "stop", "new", "exec"]);
  });

  it("restore: a runtime left behind is released; a fresh one is reused", async () => {
    const stale = setup({ now: () => 1_000_000 });
    stale.store.save({ name: "old-name", state: "ready", createdAt: 0, lastUsedAt: 1_000_000 - config.idleMs });
    await stale.runner.restore();
    expect(stale.calls).toEqual([["stop", "-s", "old-name"]]);
    expect(stale.store.load()).toBeUndefined();

    const creating = setup({ now: () => 1_000_000 });
    creating.store.save({ name: "rf-test", state: "creating", createdAt: 999_999, lastUsedAt: 999_999 }); // crashed during `colab new`
    await creating.runner.restore();
    expect(creating.subs()).toEqual(["stop"]);

    const fresh = setup({ now: () => 1_000_000 });
    fresh.store.save({ name: "rf-test", state: "ready", createdAt: 0, lastUsedAt: 1_000_000 - 1000 });
    await fresh.runner.restore();
    await fresh.runner.run(req);
    expect(fresh.subs()).toEqual(["exec"]);
  });

  it("caps runs per hour for all callers together", async () => {
    let now = 0;
    const t = setup({ config: { maxPerHour: 2 }, now: () => now });
    await t.runner.run(req);
    await t.runner.run(req);
    expect(() => t.runner.run(req)).toThrow(/at most 2 Python runs per hour/);
    now = 3_600_001;
    expect((await t.runner.run(req)).exitCode).toBe(0);
  });

  it("passes --auth before the subcommand when configured", async () => {
    const t = setup({ config: { auth: "adc" } });
    await t.runner.run(req);
    expect(t.calls[0]).toEqual(["--auth", "adc", "new", "-s", "rf-test"]);
  });

  it("shutdown releases the runtime", async () => {
    const t = setup();
    await t.runner.run(req);
    await t.runner.shutdown();
    expect(t.subs().at(-1)).toBe("stop");
    expect(t.store.load()).toBeUndefined();
  });
});
