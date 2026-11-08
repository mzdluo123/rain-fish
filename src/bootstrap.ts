import consola from "consola";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import type { Config, Logger } from "./types.js";

/**
 * Shared startup for every entry point: reads `.env` (Bun loads it automatically) and the process
 * environment, validates it, and builds the logger. Invalid configuration prints a readable error and exits.
 */
export function bootstrap(): { config: Config; logger: Logger } {
  try {
    const config = loadConfig();
    return { config, logger: createLogger(config.logLevel) };
  } catch (err) {
    consola.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/** Runs startup work that can fail on bad configuration (unknown model, ...): logs the reason and exits instead of dumping a stack trace. */
export function orExit<T>(logger: Logger, work: () => T): T {
  try {
    return work();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
