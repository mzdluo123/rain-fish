import { z } from "zod";
import type { Config } from "./types.js";

/** `true`/`false`/`1`/`0` (case-insensitive) -> boolean. */
const flag = (def: boolean) =>
  z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .pipe(z.enum(["true", "false", "1", "0"]))
    .transform((s) => s === "true" || s === "1")
    .default(def);

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
    /** Host file whose text becomes the agent's `/persona.md` the first time the database has none (afterwards the agent owns that file). */
    PERSONA_SEED_FILE: z.string().min(1).default("prompts/persona.md"),
    // --- state / logging ---
    DB_PATH: z.string().min(1).default("data/bot.db"),
    LOG_LEVEL: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
    // --- model ---
    /** `provider/model-id`, e.g. `anthropic/claude-sonnet-4-5`. Unset: Pi's default model. */
    MODEL: z
      .string()
      .regex(/^[^/\s]+\/\S+$/, "must look like provider/model-id")
      .optional(),
    /** Thinking effort: `off` disables thinking. Unset: Pi's default (medium, clamped to what the model supports). */
    THINKING_LEVEL: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    /** How long the provider keeps the cached prompt prefix: "long" = 1 hour (Anthropic), "short" = the provider's default (5 minutes). Sets Pi's PI_CACHE_RETENTION. */
    CACHE_RETENTION: z.enum(["short", "long"]).default("long"),
    // --- context management (tokens) ---
    /** Newest history that compaction keeps verbatim (it only retires what is older, cutting at a turn start). */
    CONTEXT_RECENT_TOKENS: z.coerce.number().int().positive().default(12_000),
    /** When the context grows past this, older history is snap-compacted into the archive. */
    CONTEXT_COMPACT_TOKENS: z.coerce.number().int().positive().default(60_000),
    /** Token budget of the archive (bitmap frames) that replaces the compacted history. */
    CONTEXT_ARCHIVE_TOKENS: z.coerce.number().int().positive().default(20_000),
    /** Memory flush: once the context passes this fraction of COMPACT, the agent is asked to save what matters to its files first. */
    CONTEXT_FLUSH_RATIO: z.coerce.number().gt(0).lt(1).default(0.85),
    // --- wake-ups ---
    // The wake-up comes after the chat has gone quiet (Hawkes excitation, see src/wake-intensity.ts) plus a random "reaction time".
    /** Mean seconds of the random reaction time (exponential) added after the chat has gone quiet, while only ordinary chatter is pending. */
    WAKE_CHAT_MEAN_SECONDS: z.coerce.number().nonnegative().default(45),
    /** Same, once a pending message @-mentions the bot or replies to it. 0 = no extra delay. */
    WAKE_ADDRESSED_MEAN_SECONDS: z.coerce.number().nonnegative().default(1),
    /** Hawkes decay rate beta, per second: how fast a burst of messages cools down (0.4 -> half-life ~1.7 s). */
    WAKE_DECAY_PER_SECOND: z.coerce.number().positive().default(0.4),
    /** The chat counts as quiet when the excitation is down to this many ordinary messages (smaller = wait longer after a burst). */
    WAKE_QUIET_THRESHOLD: z.coerce.number().positive().default(0.3),
    /** Upper bound, from the first pending message, however busy the chat stays. */
    WAKE_MAX_WAIT_SECONDS: z.coerce.number().positive().default(120),
    /** Same, measured from the first pending message that is addressed to the bot. */
    WAKE_ADDRESSED_MAX_WAIT_SECONDS: z.coerce.number().positive().default(20),
    /** This many pending messages wake the agent at once. */
    WAKE_MAX_BATCH: z.coerce.number().int().positive().default(30),
    /** Every this many agent runs of a group, the next batch carries a system notice that the agent must say something. 0 = never. */
    SPEAK_EVERY_RUNS: z.coerce.number().int().nonnegative().default(3),
    // --- history backfill ---
    /** At startup, a group with fewer stored messages than this gets its recent history pulled from the QQ API. 0 = never. */
    BACKFILL_MIN_MESSAGES: z.coerce.number().int().nonnegative().default(100),
    /** Only messages newer than this many days are backfilled. */
    BACKFILL_MAX_AGE_DAYS: z.coerce.number().positive().default(5),
    // --- images ---
    /** Largest image (bytes) fetched for the agent; bigger ones stay a `[图片]` placeholder. 0 = images are never fetched. Needs a vision model. */
    IMAGE_MAX_BYTES: z.coerce.number().int().nonnegative().default(3 * 1024 * 1024),
    /** At most this many images (the newest) are attached to one wake-up; the rest stay placeholders. */
    IMAGE_MAX_PER_RUN: z.coerce.number().int().nonnegative().default(4),
    /** Pictures of incoming messages are downloaded and kept (so the agent can look at and re-send them later) up to this many bytes in total; the least recently used go first. 0 = pictures are not kept. */
    IMAGE_STORE_MAX_BYTES: z.coerce.number().int().nonnegative().default(200 * 1024 * 1024),
    /** The model sees a scaled-down copy of every picture (same aspect ratio, never enlarged): at most this many pixels (tokens ~ pixels / 750). 0 = send pictures as they are. */
    IMAGE_MODEL_MAX_PIXELS: z.coerce.number().int().nonnegative().default(800_000),
    /** ... and at most this long a side (the big providers resize anything above ~1568 px themselves). */
    IMAGE_MODEL_MAX_EDGE: z.coerce.number().int().positive().default(1568),
    /** Pixel budget of `view_image` when the agent asks for detail (about the providers' own limit). */
    IMAGE_DETAIL_MAX_PIXELS: z.coerce.number().int().positive().default(1_150_000),
    // --- what the agent posts in one run ---
    /** Messages (`send` + `send_image`) the agent may post in one run; more are refused until the next wake-up. */
    SEND_MAX_PER_RUN: z.coerce.number().int().positive().default(6),
    /** Pause before the second and later message of a run, ms (looks less robotic, stays under QQ's rate limits). */
    SEND_GAP_MS: z.coerce.number().int().nonnegative().default(800),
    // --- execution trace (structured, rotating event log) ---
    TRACE_ENABLED: flag(true),
    /** Directory of the trace files (`agent.jsonl` + rotated `agent.<time>.jsonl.gz`). */
    TRACE_DIR: z.string().min(1).default("data/logs"),
    /** Rotate the live file when it would pass this size. */
    TRACE_MAX_FILE_MB: z.coerce.number().positive().default(20),
    /** Rotated files kept (newest first). */
    TRACE_MAX_FILES: z.coerce.number().int().positive().default(30),
    /** Rotated files whose last write is older than this are deleted. */
    TRACE_MAX_AGE_DAYS: z.coerce.number().positive().default(14),
    TRACE_COMPRESS: flag(true),
    /** Include (clipped) message text, tool arguments and results in events. Off: only sizes, ids and names. */
    TRACE_CONTENT: flag(false),
  })
  .transform((e) => ({
    wsUrl: e.QQ_WS_URL,
    token: e.QQ_TOKEN,
    groups: e.QQ_GROUPS,
    promptFile: e.PROMPT_FILE,
    personaSeedFile: e.PERSONA_SEED_FILE,
    dbPath: e.DB_PATH,
    logLevel: e.LOG_LEVEL,
    model: e.MODEL,
    thinkingLevel: e.THINKING_LEVEL,
    cacheRetention: e.CACHE_RETENTION,
    context: {
      recentTokens: e.CONTEXT_RECENT_TOKENS,
      compactTokens: e.CONTEXT_COMPACT_TOKENS,
      archiveTokens: e.CONTEXT_ARCHIVE_TOKENS,
      flushRatio: e.CONTEXT_FLUSH_RATIO,
    },
    speakEveryRuns: e.SPEAK_EVERY_RUNS,
    wake: {
      chatMeanMs: e.WAKE_CHAT_MEAN_SECONDS * 1000,
      addressedMeanMs: e.WAKE_ADDRESSED_MEAN_SECONDS * 1000,
      decayPerSec: e.WAKE_DECAY_PER_SECOND,
      quietThreshold: e.WAKE_QUIET_THRESHOLD,
      maxWaitMs: e.WAKE_MAX_WAIT_SECONDS * 1000,
      addressedMaxWaitMs: e.WAKE_ADDRESSED_MAX_WAIT_SECONDS * 1000,
      maxBatch: e.WAKE_MAX_BATCH,
    },
    images: {
      maxBytes: e.IMAGE_MAX_BYTES,
      maxPerRun: e.IMAGE_MAX_PER_RUN,
      storeMaxBytes: e.IMAGE_STORE_MAX_BYTES,
      modelMaxPixels: e.IMAGE_MODEL_MAX_PIXELS,
      modelMaxEdge: e.IMAGE_MODEL_MAX_EDGE,
      detailMaxPixels: e.IMAGE_DETAIL_MAX_PIXELS,
    },
    send: {
      maxPerRun: e.SEND_MAX_PER_RUN,
      gapMs: e.SEND_GAP_MS,
    },
    backfill: {
      minMessages: e.BACKFILL_MIN_MESSAGES,
      maxAgeSeconds: e.BACKFILL_MAX_AGE_DAYS * 86_400,
    },
    trace: {
      enabled: e.TRACE_ENABLED,
      dir: e.TRACE_DIR,
      maxFileBytes: Math.round(e.TRACE_MAX_FILE_MB * 1024 * 1024),
      maxFiles: e.TRACE_MAX_FILES,
      maxAgeDays: e.TRACE_MAX_AGE_DAYS,
      compress: e.TRACE_COMPRESS,
      content: e.TRACE_CONTENT,
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
