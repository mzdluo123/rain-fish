import type { CliResult, ColabCli } from "../types.js";

/**
 * The `colab` CLI (google-colab-cli) as a child process. The argument vector is built by `ColabRunner` from config values only and
 * passed to `Bun.spawn` as an array: no shell, nothing the agent wrote is ever an argument. Code reaches the CLI on stdin and is
 * executed by the remote Jupyter kernel, never on this host. stdin is closed when there is nothing to pipe, so a CLI that wants to
 * ask something (a login flow) fails instead of hanging. The process is SIGKILLed on timeout or abort.
 */
export function createColabCli(bin: string): ColabCli {
  return {
    async run(args, { stdin, timeoutMs, signal }) {
      const proc = Bun.spawn([bin, ...args], {
        stdin: stdin === undefined ? "ignore" : Buffer.from(stdin, "utf-8"),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      });
      let timedOut = false;
      let aborted = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeoutMs);
      const onAbort = () => {
        aborted = true;
        proc.kill("SIGKILL");
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { code, stdout, stderr, timedOut, aborted } satisfies CliResult;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
