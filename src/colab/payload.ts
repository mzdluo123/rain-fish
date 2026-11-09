import { z } from "zod";
import type { PythonRunResult } from "../types.js";

/** Remote directory under which every run gets its own temporary working directory (deleted afterwards). */
export const REMOTE_RUN_ROOT = "/content/rain-fish-runs";

/**
 * The code sent to the Colab kernel for one run. The kernel only launches: the script runs as its own `python` process in a fresh
 * temporary directory, in its own process group, with stdin closed, so no variables leak from one run into the next and a timeout
 * kills everything the script started. Output goes to files (no pipe can fill up) and only head + tail come back. Everything the
 * agent supplied (file name, source) travels as base64 JSON, so nothing it wrote is ever spliced into Python syntax. The result is
 * one line `<marker><json>` on the kernel's stdout; the script's own output never reaches that stream.
 */
export function buildPayload(a: { name: string; source: string; timeoutSeconds: number; maxBytes: number; marker: string }): string {
  const args = Buffer.from(JSON.stringify({ name: a.name, source: a.source, timeout: a.timeoutSeconds, max_bytes: a.maxBytes, marker: a.marker, root: REMOTE_RUN_ROOT }), "utf-8").toString("base64");
  return `def __rain_fish_run(packed):
    import base64, json, os, shutil, signal, subprocess, sys, tempfile, time
    a = json.loads(base64.b64decode(packed).decode("utf-8"))
    res = {}
    d = None
    try:
        os.makedirs(a["root"], exist_ok=True)
        d = tempfile.mkdtemp(prefix="run-", dir=a["root"])
        script = os.path.join(d, a["name"])
        with open(script, "w", encoding="utf-8") as f:
            f.write(a["source"])
        paths = {"stdout": os.path.join(d, ".stdout"), "stderr": os.path.join(d, ".stderr")}
        t0 = time.monotonic()
        with open(paths["stdout"], "wb") as out, open(paths["stderr"], "wb") as err:
            proc = subprocess.Popen([sys.executable, a["name"]], cwd=d, stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True)
            timed_out = False
            try:
                proc.wait(timeout=a["timeout"])
            except subprocess.TimeoutExpired:
                timed_out = True
            try:
                os.killpg(proc.pid, signal.SIGKILL)  # the script, or what it left running in the background
            except (ProcessLookupError, PermissionError):
                pass
            proc.wait()
        res.update(exit_code=proc.returncode, timed_out=timed_out, duration_ms=int((time.monotonic() - t0) * 1000))
        limit = a["max_bytes"]
        for key, path in paths.items():
            size = os.path.getsize(path)
            with open(path, "rb") as f:
                if size <= limit:
                    head, tail = f.read(), b""
                else:
                    head = f.read(limit // 2)
                    f.seek(size - (limit - limit // 2))
                    tail = f.read()
            res[key] = {"head": head.decode("utf-8", "replace"), "tail": tail.decode("utf-8", "replace"), "bytes": size}
    except Exception as e:
        res = {"error": repr(e)}
    finally:
        if d:
            shutil.rmtree(d, ignore_errors=True)
    print(a["marker"] + json.dumps(res), flush=True)

__rain_fish_run("${args}")
del __rain_fish_run
`;
}

const streamSchema = z.object({ head: z.string(), tail: z.string(), bytes: z.number().int().nonnegative() });
const resultSchema = z.union([
  z.object({ error: z.string() }),
  z.object({ exit_code: z.number().int(), timed_out: z.boolean(), duration_ms: z.number().int().nonnegative(), stdout: streamSchema, stderr: streamSchema }),
]);

/**
 * Finds the result line of a run in the CLI's stdout. `undefined`: there is none (the kernel never ran the payload: session lost,
 * CLI failure). Remote data: validated before use; a line that does not parse counts as missing. `error`: the launcher itself failed.
 */
export function parseResult(stdout: string, marker: string): { ok: PythonRunResult } | { error: string } | undefined {
  const line = stdout.split("\n").find((l) => l.startsWith(marker));
  if (line === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(line.slice(marker.length));
  } catch {
    return undefined;
  }
  const r = resultSchema.safeParse(json);
  if (!r.success) return undefined;
  if ("error" in r.data) return { error: r.data.error };
  const d = r.data;
  return { ok: { exitCode: d.exit_code, timedOut: d.timed_out, durationMs: d.duration_ms, stdout: d.stdout, stderr: d.stderr } };
}
