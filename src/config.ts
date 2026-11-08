import { z } from "zod";
import type { Config } from "./types.js";

/** Every setting the program reads from the environment / `.env`, with its default. */
export const configSchema = z
  .object({
    // --- QQ / NapCat ---
    QQ_WS_URL: z
      .url()
      .refine((u) => /^wss?:\/\//.test(u), "must be a ws:// or wss:// URL")
      .default("ws://127.0.0.1:3001"),
    QQ_TOKEN: z.string().min(1).optional(),
    QQ_GROUPS: z
      .string()
      .optional()
      .transform((s) => {
        const ids = (s ?? "").split(",").map((g) => g.trim()).filter(Boolean);
        return ids.length ? new Set(ids) : undefined;
      }),
    // --- system prompt ---
    /** Host file used verbatim as the agent's system prompt. It is not part of the agent's filesystem. */
    PROMPT_FILE: z.string().min(1).default("prompts/agent.md"),
    // --- state / logging ---
    DB_PATH: z.string().min(1).default("data/bot.db"),
    LOG_LEVEL: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
    // --- model ---
    /** `provider/model-id`, e.g. `anthropic/claude-sonnet-4-5`. Unset: Pi's default model. */
    MODEL: z
      .string()
      .regex(/^[^/\s]+\/\S+$/, "must look like provider/model-id")
      .optional(),
    // --- context management (tokens) ---
    /** Newest history that is never touched: protected from level-1 pruning, kept verbatim by level-2 compaction. */
    CONTEXT_RECENT_TOKENS: z.coerce.number().int().positive().default(12_000),
    /** Level 1: an old tool result / tool-call argument at least this big is cleared. */
    CONTEXT_PRUNE_MIN_TOKENS: z.coerce.number().int().positive().default(800),
    /** Level 2: when the context grows past this, older history is snap-compacted into the archive. */
    CONTEXT_COMPACT_TOKENS: z.coerce.number().int().positive().default(60_000),
    /** Level 2: token budget of the archive (bitmap frames) that replaces the compacted history. */
    CONTEXT_ARCHIVE_TOKENS: z.coerce.number().int().positive().default(20_000),
  })
  .transform((e) => ({
    wsUrl: e.QQ_WS_URL,
    token: e.QQ_TOKEN,
    groups: e.QQ_GROUPS,
    promptFile: e.PROMPT_FILE,
    dbPath: e.DB_PATH,
    logLevel: e.LOG_LEVEL,
    model: e.MODEL,
    context: {
      recentTokens: e.CONTEXT_RECENT_TOKENS,
      pruneMinTokens: e.CONTEXT_PRUNE_MIN_TOKENS,
      compactTokens: e.CONTEXT_COMPACT_TOKENS,
      archiveTokens: e.CONTEXT_ARCHIVE_TOKENS,
    },
  }))
  .refine((c) => c.context.recentTokens + c.context.archiveTokens < c.context.compactTokens, {
    path: ["CONTEXT_COMPACT_TOKENS"],
    message: "must be larger than CONTEXT_RECENT_TOKENS + CONTEXT_ARCHIVE_TOKENS, or compaction could not get below it",
  });

/** Validates environment variables once, at startup; throws a readable error on bad values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // `KEY=` in a .env file means "not set" (as .env.example ships), so defaults must still apply.
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const r = configSchema.safeParse(set);
  if (!r.success) {
    const problems = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return r.data;
}
