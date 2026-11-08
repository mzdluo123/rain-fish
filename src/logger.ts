import { createConsola, type ConsolaReporter } from "consola";
import { format } from "node:util";
import type { LogLevel, Logger } from "./types.js";

/** consola's numeric levels: error 0, warn 1, info 3, debug 4. */
const LEVELS: Record<LogLevel, number> = { silent: -999, error: 0, warn: 1, info: 3, debug: 4 };

/** One greppable line per entry with a local timestamp: what you want in a log file or `journalctl`. */
const plainReporter: ConsolaReporter = {
  log(entry, ctx) {
    const when = entry.date.toLocaleString("sv-SE");
    const tag = entry.tag ? `[${entry.tag}] ` : "";
    const line = `${when} ${entry.type.toUpperCase().padEnd(7)} ${tag}${format(...entry.args)}\n`;
    (entry.level < 2 ? ctx.options.stderr : ctx.options.stdout)?.write(line);
  },
};

/**
 * Coloured, icon-and-badge output with timestamps on a terminal; timestamped plain lines when
 * stdout is piped or redirected. `fancy` overrides the terminal detection.
 */
export function createLogger(level: LogLevel, opts: { fancy?: boolean } = {}): Logger {
  const fancy = opts.fancy ?? Boolean(process.stdout.isTTY);
  return createConsola({
    level: LEVELS[level],
    fancy,
    // Only override reporters when not fancy: an explicit `reporters: undefined` would disable the default one.
    ...(fancy ? {} : { reporters: [plainReporter] }),
    formatOptions: { date: true },
  });
}

/** Logs nothing; the default when a component is given no logger. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  success() {},
  warn() {},
  error() {},
  withTag: () => noopLogger,
};
