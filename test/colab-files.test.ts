import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkTransferSizes, remoteFilePath } from "../src/colab/files.js";
import { buildPayload, parseResult } from "../src/colab/payload.js";

/** Exercise the actual payload with fixture scripts. Only privileged user setup/cleanup is stubbed;
 * process cleanup (scoped to fixture children), file transfer and output collection run unchanged. */
function runFixture(source: string, outputs = ["nested/out.bin"], inputs = [{ path: "data/in.bin", base64: Buffer.from([0, 255, 128, 10]).toString("base64") }], timeoutSeconds = 5, leaveZombie = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), "colab-files-"));
  try {
    let code = buildPayload({ name: "main.py", source, inputFiles: inputs, outputFiles: outputs, args: [], env: {}, timeoutSeconds, maxBytes: 100, marker: "@@M@@" });
    code = code.replace('    res = {}', `    a["root"] = ${JSON.stringify(root)}\n    res = {}`)
      .replace('if os.geteuid() != 0:', 'if False:')
      .replaceAll('pwd.getpwnam(a["user"])', 'pwd.getpwuid(os.getuid())')
      // Keep real process cleanup, but restrict /proc scans to children launched by this fixture.
      .replace('if not pid.isdigit():', 'if not pid.isdigit() or int(pid) not in fixture_pids:')
      .replace(/ {4}def remove_owned\(uid\):[\s\S]*? {4}try:\n {8}if False:/, '    def remove_owned(uid):\n        pass\n\n    try:\n        if False:')
      .replaceAll('os.chown(', 'ignore_chown(')
      .replace(', user=uid, group=gid, extra_groups=[]', '');
    const r = Bun.spawnSync(["python3", "-"], { stdin: Buffer.from(`import subprocess
fixture_pids = set()
fixture_popen = subprocess.Popen
# Leave an exited child unreaped: cleanup must ignore it without relying on init to reap it.
import time
fixture_zombie = None
if ${leaveZombie ? "True" : "False"}:
    fixture_zombie = fixture_popen(["python3", "-c", "pass"])
    fixture_pids.add(fixture_zombie.pid)
    for _ in range(100):
        with open(f"/proc/{fixture_zombie.pid}/status") as f:
            if any(line.startswith("State:") and "Z" in line for line in f):
                break
        time.sleep(0.01)
    else:
        raise RuntimeError("fixture child did not become a zombie")
def tracked_popen(*args, **kwargs):
    proc = fixture_popen(*args, **kwargs)
    fixture_pids.add(proc.pid)
    return proc
subprocess.Popen = tracked_popen
ignore_chown = lambda *args: None
` + code + "\nif fixture_zombie is not None:\n    fixture_zombie.wait()\n") });
    expect(r.exitCode).toBe(0);
    const result = parseResult(r.stdout.toString(), "@@M@@");
    if (!result || !("ok" in result)) throw new Error(JSON.stringify(result) + r.stderr.toString());
    return result.ok;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Colab file transfer", () => {
  it.skipIf(process.getuid?.() === 0 || Bun.which("python3") === null)("preserves timeout status and captured output with real process cleanup", () => {
    const r = runFixture("import sys, time\nprint('before timeout', flush=True)\nprint('error before timeout', file=sys.stderr, flush=True)\ntime.sleep(30)", [], [], 1, false);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-9);
    expect(r.stdout.head).toContain("before timeout");
    expect(r.stderr.head).toContain("error before timeout");
    expect(r.files).toBeUndefined();
  });

  it("rejects absolute paths, traversal, ambiguous paths and NULs", () => {
    for (const p of ["/etc/passwd", "../x", "a/../b", "a//b", "a/./b", "a\\b", "x\0", ""]) expect(() => remoteFilePath(p)).toThrow(/EINVAL/);
    expect(remoteFilePath("data/中文.csv")).toBe("data/中文.csv");
  });

  it.skipIf(process.getuid?.() === 0 || Bun.which("python3") === null)("round trips binary files through the real Python payload", () => {
    const r = runFixture("import pathlib\np=pathlib.Path('nested/out.bin')\np.parent.mkdir()\np.write_bytes(pathlib.Path('data/in.bin').read_bytes())");
    expect(r.exitCode).toBe(0);
    expect(r.files).toEqual([{ path: "nested/out.bin", base64: "AP+ACg==" }]);
  });

  it.skipIf(process.getuid?.() === 0 || Bun.which("python3") === null)("refuses missing files, symlinks, intermediate symlinks, FIFOs and oversized outputs without partial results", () => {
    for (const source of [
      "pass",
      "import os\nos.makedirs('nested')\nos.symlink('/etc/passwd', 'nested/out.bin')",
      "import os\nos.symlink('/etc', 'nested')",
      "import os\nos.makedirs('nested')\nos.mkfifo('nested/out.bin')",
      "import pathlib\np=pathlib.Path('nested/out.bin')\np.parent.mkdir()\np.write_bytes(b'x' * (1024*1024+1))",
    ]) {
      const r = runFixture(source, source === "import os\nos.symlink('/etc', 'nested')" ? ["nested/passwd"] : undefined);
      expect(r.fileError).toBeString();
      expect(r.files).toBeUndefined();
    }
  });

  it("enforces file count and aggregate limits in addition to per-file limits", () => {
    expect(() => checkTransferSizes(Array(33).fill(0))).toThrow(/at most 32/);
    expect(() => checkTransferSizes(Array(5).fill(1024 * 1024))).toThrow(/in total/);
    expect(() => checkTransferSizes([1024 * 1024 + 1])).toThrow(/per file/);
    expect(() => checkTransferSizes(Array(4).fill(1024 * 1024))).not.toThrow();
  });

  it("parses maximum-sized binary results and rejects invalid Base64", () => {
    const file = { path: "out", base64: Buffer.alloc(1024 * 1024, 255).toString("base64") };
    const response = { exit_code: 0, timed_out: false, duration_ms: 1, stdout: { head: "", tail: "", bytes: 0 }, stderr: { head: "", tail: "", bytes: 0 }, files: [file] };
    expect(parseResult("@@M@@" + JSON.stringify(response), "@@M@@")).toHaveProperty("ok.files", [file]);
    file.base64 = "bad!";
    expect(parseResult("@@M@@" + JSON.stringify(response), "@@M@@")).toBeUndefined();
  });

  it.skipIf(process.getuid?.() === 0 || Bun.which("python3") === null)("does not collect files from failed scripts", () => {
    const r = runFixture("raise RuntimeError('failed')");
    expect(r.exitCode).toBe(1);
    expect(r.files).toBeUndefined();
  });
});
