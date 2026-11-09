import { z } from "zod";
import type { PythonRunResult } from "../types.js";

/** Remote directory under which every run gets its own temporary working directory (deleted afterwards). */
export const REMOTE_RUN_ROOT = "/content/rain-fish-runs";
/** Unprivileged user every script runs as (created on first use; the kernel itself is root). */
export const REMOTE_RUN_USER = "rainfish-run";

/**
 * The code sent to the Colab kernel for one run. The kernel (root) only launches: the script runs as its own `python` process as the
 * unprivileged user `REMOTE_RUN_USER`, in a fresh 0700 directory of its own under a run root it cannot list, in its own process group,
 * with stdin closed, so no variables leak from one run into the next. After the run (timed out or not) EVERY process of that user is
 * SIGKILLed (a `/proc` scan, so `setsid`/double-forked children die too), before the next run as well, and the directory is deleted.
 * A kernel that is not root fails the run with an error instead of running the script unisolated. Output goes to root-only files
 * (no pipe can fill up, the script cannot swap them for links) and only head + tail come back. Everything the agent supplied (file
 * name, source, argv) travels as base64 JSON and reaches `Popen` as a list (no shell); the script is passed by absolute path, so a
 * name like `-c` is never a `python` option, and an argument after it belongs to the script. The result is one line
 * `<marker><json>` on the kernel's stdout; the script's own output never reaches that stream.
 */
export function buildPayload(a: { name: string; source: string; args: readonly string[]; env: Readonly<Record<string, string>>; timeoutSeconds: number; maxBytes: number; marker: string }): string {
  const packed = Buffer.from(JSON.stringify({ name: a.name, source: a.source, args: a.args, env: a.env, timeout: a.timeoutSeconds, max_bytes: a.maxBytes, marker: a.marker, root: REMOTE_RUN_ROOT, user: REMOTE_RUN_USER }), "utf-8").toString("base64");
  return `def __rain_fish_run(packed):
    import base64, json, os, pwd, shutil, signal, stat, subprocess, sys, tempfile, time
    a = json.loads(base64.b64decode(packed).decode("utf-8"))
    res = {}
    d = None
    o = None
    uid = None

    def kill_all(uid):
        # Every process of the run user, wherever it went (setsid, double fork): SIGKILL until none is left (bounded).
        for _ in range(100):
            found = False
            for pid in os.listdir("/proc"):
                if not pid.isdigit():
                    continue
                try:
                    with open("/proc/" + pid + "/status", encoding="utf-8") as f:
                        uids = next((l.split()[1:] for l in f if l.startswith("Uid:")), [])
                except OSError:
                    continue
                if str(uid) in uids:
                    found = True
                    try:
                        os.kill(int(pid), signal.SIGKILL)
                    except OSError:
                        pass
            if not found:
                return True
            time.sleep(0.05)
        return False

    def remove_owned(uid):
        # Files the run user left in the shared writable places (a later run of another group must not read or reuse them).
        for base in ("/tmp", "/var/tmp", "/dev/shm"):
            for top, dirs, files in os.walk(base, topdown=True, followlinks=False):
                for name in list(dirs) + files:
                    p = os.path.join(top, name)
                    try:
                        st = os.lstat(p)
                    except OSError:
                        continue
                    if st.st_uid != uid:
                        continue
                    if name in dirs:
                        dirs.remove(name)
                    try:
                        if stat.S_ISDIR(st.st_mode):
                            shutil.rmtree(p, ignore_errors=True)
                        else:
                            os.unlink(p)
                    except OSError:
                        pass

    try:
        if os.geteuid() != 0:
            raise RuntimeError("the Colab kernel is not root, so the script cannot run as its own unprivileged user; refusing to run it unisolated")
        try:
            pw = pwd.getpwnam(a["user"])
        except KeyError:
            subprocess.run(["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", a["user"]], check=True, stdin=subprocess.DEVNULL, capture_output=True)
            pw = pwd.getpwnam(a["user"])
        uid, gid = pw.pw_uid, pw.pw_gid
        if uid == 0 or gid == 0:
            raise RuntimeError("the run user " + a["user"] + " is privileged")
        if not kill_all(uid):
            raise RuntimeError("processes of an earlier run could not be killed")
        remove_owned(uid)
        os.makedirs(a["root"], exist_ok=True)
        os.chown(a["root"], 0, 0)
        os.chmod(a["root"], 0o711)  # the run user may enter its own directory but not list or open the others
        d = tempfile.mkdtemp(prefix="run-", dir=a["root"])
        o = tempfile.mkdtemp(prefix="out-", dir=a["root"])  # root-only: the script cannot swap its output files for links
        script = os.path.join(d, a["name"])
        with open(script, "w", encoding="utf-8") as f:
            f.write(a["source"])
        os.chown(script, uid, gid)
        os.chown(d, uid, gid)
        os.chmod(d, 0o700)
        paths = {"stdout": os.path.join(o, "stdout"), "stderr": os.path.join(o, "stderr")}
        env = {**os.environ, **a["env"], "HOME": d, "TMPDIR": d, "USER": a["user"], "LOGNAME": a["user"]}
        t0 = time.monotonic()
        with open(paths["stdout"], "wb") as out, open(paths["stderr"], "wb") as err:
            proc = subprocess.Popen([sys.executable, script, *a["args"]], cwd=d, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True, user=uid, group=gid, extra_groups=[])
            timed_out = False
            try:
                proc.wait(timeout=a["timeout"])
            except subprocess.TimeoutExpired:
                timed_out = True
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            kill_all(uid)  # what the script left running in the background, in any group or session
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
        if uid is not None:
            kill_all(uid)
            remove_owned(uid)
        for p in (d, o):
            if p:
                shutil.rmtree(p, ignore_errors=True)
    print(a["marker"] + json.dumps(res), flush=True)

__rain_fish_run("${packed}")
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
