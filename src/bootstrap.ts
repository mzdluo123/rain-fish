import consola from "consola";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createEventLog } from "./trace/event-log.js";
import type { Config, EventLog, Logger } from "./types.js";

/**
 * Prompt-cache lifetime: Pi reads `PI_CACHE_RETENTION` ("long" = 1 hour on providers that support it, otherwise the short default)
 * when it builds every request, so setting it once at startup covers all sessions. `CACHE_RETENTION` in `.env` is the setting; it wins over a
 * `PI_CACHE_RETENTION` already in the environment.
 */
export function applyCacheRetention(retention: Config["cacheRetention"], env: Record<string, string | undefined> = process.env): void {
  env.PI_CACHE_RETENTION = retention;
}

/**
 * Shared startup for every entry point: reads `.env` (Bun loads it automatically) and the process
 * environment, validates it, and builds the logger and the structured event log (`TRACE_*`).
 * Invalid configuration prints a readable error and exits.
 */
export function bootstrap(): { config: Config; logger: Logger; events: EventLog } {
  try {
    const config = loadConfig();
    applyCacheRetention(config.cacheRetention);
    const logger = createLogger(config.logLevel);
    return { config, logger, events: createEventLog(config.trace, logger) };
  } catch (err) {
    consola.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/** Runs startup work (sync or async) that can fail on bad configuration (unknown model, ...): logs the reason and exits instead of dumping a stack trace. */
export function orExit<T>(logger: Logger, work: () => T): T {
  const fail = (err: unknown): never => {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  };
  try {
    const result = work();
    return result instanceof Promise ? (result.catch(fail) as T) : result;
  } catch (err) {
    return fail(err);
  }
}

