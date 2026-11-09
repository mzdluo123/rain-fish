import path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PythonRunResult, PythonTool, StreamOutput } from "../types.js";
import { VirtualFs } from "../vfs.js";
import { element } from "../xml.js";

export const RUN_PYTHON_TOOL = "run_python";
/** Largest script uploaded (the agent writes at most 10 KiB per file; host-imported files may be bigger). */
export const PYTHON_SOURCE_MAX_BYTES = 64 * 1024;
/** The most output (per stream) the agent may ask for in one run: all of it enters the context. */
export const PYTHON_OUTPUT_MAX_BYTES = 64 * 1024;
/** Command-line arguments of one run: how many, and how many bytes together. */
export const PYTHON_MAX_ARGS = 32;
export const PYTHON_ARGS_MAX_BYTES = 8 * 1024;

/** How many `run_python` calls one agent run may make; the conversation resets it per run. */
export class PythonRunCount {
  private n = 0;
  constructor(readonly max: number) {}
  get used(): number {
    return this.n;
  }
  acquire(): void {
    if (this.n >= this.max) throw new Error(`Run limit reached: at most ${this.max} run_python calls per run.`);
    this.n++;
  }
  reset(): void {
    this.n = 0;
  }
}

function stream(name: string, s: StreamOutput): string {
  if (s.bytes === 0) return `<${name}/>`;
  const cut = s.tail ? s.bytes - Buffer.byteLength(s.head, "utf-8") - Buffer.byteLength(s.tail, "utf-8") : 0;
  const body = s.tail ? `${s.head}\n…[${cut} bytes omitted]…\n${s.tail}` : s.head;
  // Output is whatever the script printed, and the script may be group-influenced: escaped like member text.
  return element(name, { bytes: String(s.bytes), truncated: s.tail ? "true" : undefined }, body);
}

export function formatRunResult(file: string, r: PythonRunResult, timeoutSeconds: number): string {
  const status = r.timedOut ? `timed out after ${timeoutSeconds}s and was killed` : `exit code ${r.exitCode}`;
  return [`${file}: ${status} (${(r.durationMs / 1000).toFixed(1)}s)`, stream("stdout", r.stdout), stream("stderr", r.stderr)].join("\n");
}

/**
 * Runs one `.py` file of the agent's filesystem on the remote Google Colab CPU machine and returns its exit code and output. The
 * file is read through `VirtualFs` only (never a host path), and its text is shipped to Colab: nothing runs on this host.
 * `sequential`: a batch with it runs in call order, and `createAgent` holds it back when the same batch writes or edits a file.
 */
export function createRunPythonTool(fs: VirtualFs, python: PythonTool) {
  return defineTool({
    name: RUN_PYTHON_TOOL,
    label: "Run Python",
    description:
      "Run one Python file from your filesystem on a remote Google Colab CPU machine and get its exit code, stdout and stderr. " +
      "Only this one file is uploaded: it cannot import your other files. It runs as a fresh `python` process in an empty temporary directory that is deleted afterwards; " +
      "nothing carries over between runs, and stdin is empty (no input()); pass inputs as command-line arguments (`args`, read with sys.argv[1:]). Common packages (numpy, pandas, ...) are installed and the machine has internet access. " +
      `The first run after a pause also starts the machine and may take a minute or two. Output longer than the limit is cut in the middle (head + tail are kept); ` +
      `if you need more, prefer making the script print only what you need; raise max_output_bytes only when you really need the whole output (it all enters your context). At most ${python.count.max} runs per run of yours.`,
    promptSnippet: "Run a .py file on a remote Colab machine (exit code + output)",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path of the .py file, e.g. /scripts/calc.py." }),
      args: Type.Optional(Type.Array(Type.String(), { maxItems: PYTHON_MAX_ARGS, description: `Command-line arguments for the script, one string each (sys.argv[1:]); no shell, so quotes and spaces are taken literally. At most ${PYTHON_MAX_ARGS}, ${PYTHON_ARGS_MAX_BYTES} bytes in total.` })),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: python.maxTimeoutSeconds, description: `Wall-clock limit; the script is killed after it. Default ${python.defaultTimeoutSeconds}, at most ${python.maxTimeoutSeconds}.` })),
      max_output_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: PYTHON_OUTPUT_MAX_BYTES, description: `Bytes of stdout and of stderr returned (each). Default ${python.defaultOutputBytes}, at most ${PYTHON_OUTPUT_MAX_BYTES}.` })),
    }),
    executionMode: "sequential",
    execute: async (toolCallId, p, signal) => {
      const file = VirtualFs.normalize(p.path);
      if (!/\.py$/i.test(file)) throw new Error(`EINVAL: '${file}' is not a .py file. Only Python files can be run.`);
      const st = fs.stat(file);
      if (!st) throw new Error(`ENOENT: no such file, '${file}'`);
      if (st.kind !== "file") throw new Error(`EISDIR: '${file}' is a directory.`);
      const source = fs.readText(file);
      if (Buffer.byteLength(source, "utf-8") > PYTHON_SOURCE_MAX_BYTES) throw new Error(`EFBIG: '${file}' is over ${PYTHON_SOURCE_MAX_BYTES} bytes; make it shorter.`);
      const args = p.args ?? [];
      if (args.length > PYTHON_MAX_ARGS) throw new Error(`EINVAL: at most ${PYTHON_MAX_ARGS} arguments.`);
      if (args.some((a) => a.includes("\0"))) throw new Error("EINVAL: an argument contains a NUL character.");
      if (args.reduce((n, a) => n + Buffer.byteLength(a, "utf-8"), 0) > PYTHON_ARGS_MAX_BYTES) throw new Error(`EINVAL: the arguments are over ${PYTHON_ARGS_MAX_BYTES} bytes in total; put large inputs into the script itself.`);
      const timeoutSeconds = Math.min(p.timeout_seconds ?? python.defaultTimeoutSeconds, python.maxTimeoutSeconds);
      const maxOutputBytes = p.max_output_bytes === undefined ? undefined : Math.min(p.max_output_bytes, PYTHON_OUTPUT_MAX_BYTES);
      python.count.acquire();
      const r = await python.run({ name: path.posix.basename(file), source, args, timeoutSeconds, maxOutputBytes, signal, callId: toolCallId });
      return {
        content: [{ type: "text", text: formatRunResult(file, r, timeoutSeconds) }],
        details: { exit_code: r.exitCode, timed_out: r.timedOut, duration_ms: r.durationMs, stdout_bytes: r.stdout.bytes, stderr_bytes: r.stderr.bytes },
      };
    },
  });
}
