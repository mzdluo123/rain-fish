import type { Config } from "./types.js";
import { configSchema } from "./qq/schemas.js";

/** Validates environment variables once, at startup; throws a readable error on bad values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = configSchema.safeParse(env);
  if (!r.success) {
    const problems = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return r.data;
}
