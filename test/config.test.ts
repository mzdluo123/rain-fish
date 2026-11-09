import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("has working defaults", () => {
    expect(loadConfig({})).toEqual({ wsUrl: "ws://127.0.0.1:3001", token: undefined, groups: undefined, promptFile: "prompts/agent.md", dbPath: "data/bot.db", logLevel: "info", model: undefined, thinkingLevel: undefined, cacheRetention: "long", context: { recentTokens: 12_000, compactTokens: 60_000, archiveTokens: 20_000, flushRatio: 0.85 }, speakEveryRuns: 3, wake: { chatMeanMs: 20_000, addressedMeanMs: 1_000, decayPerSec: 0.4, quietThreshold: 0.3, maxWaitMs: 120_000, addressedMaxWaitMs: 20_000, maxBatch: 30 }, images: { maxBytes: 3 * 1024 * 1024, maxPerRun: 4, storeMaxBytes: 200 * 1024 * 1024, modelMaxPixels: 800_000, modelMaxEdge: 1568, detailMaxPixels: 1_150_000 }, send: { maxPerRun: 6, gapMs: 800 }, backfill: { minMessages: 100, maxAgeSeconds: 5 * 86_400 }, trace: { enabled: true, dir: "data/logs", maxFileBytes: 20 * 1024 * 1024, maxFiles: 30, maxAgeDays: 14, compress: true, content: false } });
  });

  it("treats empty values (KEY= in .env) as unset, so defaults apply", () => {
    expect(loadConfig({ QQ_TOKEN: "", QQ_GROUPS: "", DB_PATH: "  ", LOG_LEVEL: "", QQ_WS_URL: "" })).toEqual(loadConfig({}));
  });

  it("reads PROMPT_FILE", () => {
    expect(loadConfig({ PROMPT_FILE: "/etc/yukino.md" }).promptFile).toBe("/etc/yukino.md");
  });

  it("parses the group allowlist, trimming blanks", () => {
    expect(loadConfig({ QQ_GROUPS: " 1, 2 ,,3 " }).groups).toEqual(new Set(["1", "2", "3"]));
    expect(loadConfig({ QQ_GROUPS: " , " }).groups).toBeUndefined();
  });

  it("accepts the known log levels and rejects others", () => {
    expect(loadConfig({ LOG_LEVEL: "debug" }).logLevel).toBe("debug");
    expect(() => loadConfig({ LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });

  it("rejects a non-WebSocket or malformed URL with a readable error", () => {
    expect(() => loadConfig({ QQ_WS_URL: "http://127.0.0.1:3001" })).toThrow(/Invalid configuration.*QQ_WS_URL/);
    expect(() => loadConfig({ QQ_WS_URL: "not a url" })).toThrow(/QQ_WS_URL/);
  });

  it("reads the model and context thresholds, with defaults for anything unset", () => {
    const c = loadConfig({ MODEL: "anthropic/claude-sonnet-4-5", CONTEXT_COMPACT_TOKENS: "90000", CONTEXT_RECENT_TOKENS: "8000" });
    expect(c.model).toBe("anthropic/claude-sonnet-4-5");
    expect(c.context).toEqual({ recentTokens: 8000, compactTokens: 90_000, archiveTokens: 20_000, flushRatio: 0.85 });
    expect(loadConfig({ MODEL: "openrouter/anthropic/claude-sonnet-4.5" }).model).toBe("openrouter/anthropic/claude-sonnet-4.5");
  });

  it("rejects a malformed model and nonsensical thresholds with a readable error", () => {
    expect(() => loadConfig({ MODEL: "gpt-5" })).toThrow(/MODEL.*provider\/model-id/);
    expect(() => loadConfig({ CONTEXT_COMPACT_TOKENS: "abc" })).toThrow(/CONTEXT_COMPACT_TOKENS/);
    expect(() => loadConfig({ CONTEXT_RECENT_TOKENS: "-5" })).toThrow(/CONTEXT_RECENT_TOKENS/);
    // recent + archive must fit under the compaction threshold, or compaction could never get below it
    expect(() => loadConfig({ CONTEXT_COMPACT_TOKENS: "30000" })).toThrow(/CONTEXT_COMPACT_TOKENS.*larger than/);
  });
});

describe("prompt cache retention", () => {
  it("defaults to 1 hour (long), can be set back to short, and rejects anything else", () => {
    expect(loadConfig({}).cacheRetention).toBe("long");
    expect(loadConfig({ CACHE_RETENTION: "short" }).cacheRetention).toBe("short");
    expect(() => loadConfig({ CACHE_RETENTION: "forever" })).toThrow(/CACHE_RETENTION/);
  });

  it("is handed to Pi through PI_CACHE_RETENTION, overriding a value already in the environment", async () => {
    const { applyCacheRetention } = await import("../src/bootstrap.js");
    const env: Record<string, string | undefined> = { PI_CACHE_RETENTION: "short" };
    applyCacheRetention("long", env);
    expect(env.PI_CACHE_RETENTION).toBe("long");
    applyCacheRetention("short", env);
    expect(env.PI_CACHE_RETENTION).toBe("short");
  });
});

describe("wake-up settings", () => {
  it("default to a 20s reaction time for chatter and 1s once addressed on top of the Hawkes quiet time, and are read in seconds", () => {
    expect(loadConfig({ WAKE_CHAT_MEAN_SECONDS: "1.5", WAKE_ADDRESSED_MEAN_SECONDS: "0" }).wake).toMatchObject({ chatMeanMs: 1_500, addressedMeanMs: 0 });
    expect(loadConfig({}).wake).toEqual({ chatMeanMs: 20_000, addressedMeanMs: 1_000, decayPerSec: 0.4, quietThreshold: 0.3, maxWaitMs: 120_000, addressedMaxWaitMs: 20_000, maxBatch: 30 });
    expect(loadConfig({ WAKE_DECAY_PER_SECOND: "1", WAKE_QUIET_THRESHOLD: "0.5", WAKE_MAX_WAIT_SECONDS: "60", WAKE_ADDRESSED_MAX_WAIT_SECONDS: "10", WAKE_MAX_BATCH: "5" }).wake)
      .toMatchObject({ decayPerSec: 1, quietThreshold: 0.5, maxWaitMs: 60_000, addressedMaxWaitMs: 10_000, maxBatch: 5 });
  });

  it("rejects negative or non-numeric values", () => {
    expect(() => loadConfig({ WAKE_CHAT_MEAN_SECONDS: "-1" })).toThrow(/WAKE_CHAT_MEAN_SECONDS/);
    expect(() => loadConfig({ WAKE_ADDRESSED_MEAN_SECONDS: "soon" })).toThrow(/WAKE_ADDRESSED_MEAN_SECONDS/);
    expect(() => loadConfig({ WAKE_DECAY_PER_SECOND: "0" })).toThrow(/WAKE_DECAY_PER_SECOND/);
    expect(() => loadConfig({ WAKE_MAX_BATCH: "0" })).toThrow(/WAKE_MAX_BATCH/);
  });
});

describe("backfill settings", () => {
  it("default to 100 messages within 5 days; days are converted to seconds", () => {
    expect(loadConfig({ BACKFILL_MIN_MESSAGES: "50", BACKFILL_MAX_AGE_DAYS: "0.5" }).backfill).toEqual({ minMessages: 50, maxAgeSeconds: 43_200 });
    expect(loadConfig({ BACKFILL_MIN_MESSAGES: "0" }).backfill.minMessages).toBe(0);
  });

  it("rejects nonsense", () => {
    expect(() => loadConfig({ BACKFILL_MIN_MESSAGES: "-1" })).toThrow(/BACKFILL_MIN_MESSAGES/);
    expect(() => loadConfig({ BACKFILL_MIN_MESSAGES: "1.5" })).toThrow(/BACKFILL_MIN_MESSAGES/);
    expect(() => loadConfig({ BACKFILL_MAX_AGE_DAYS: "0" })).toThrow(/BACKFILL_MAX_AGE_DAYS/);
  });
});

describe("trace settings", () => {
  it("parse booleans in several spellings and convert MB to bytes", () => {
    const t = loadConfig({ TRACE_ENABLED: "FALSE", TRACE_COMPRESS: "0", TRACE_CONTENT: "True", TRACE_MAX_FILE_MB: "0.5", TRACE_DIR: "/var/log/fish" }).trace;
    expect(t).toMatchObject({ enabled: false, compress: false, content: true, maxFileBytes: 524_288, dir: "/var/log/fish" });
  });

  it("rejects nonsense", () => {
    expect(() => loadConfig({ TRACE_ENABLED: "maybe" })).toThrow(/TRACE_ENABLED/);
    expect(() => loadConfig({ TRACE_MAX_FILES: "0" })).toThrow(/TRACE_MAX_FILES/);
    expect(() => loadConfig({ TRACE_MAX_AGE_DAYS: "-1" })).toThrow(/TRACE_MAX_AGE_DAYS/);
    expect(() => loadConfig({ TRACE_MAX_FILE_MB: "0" })).toThrow(/TRACE_MAX_FILE_MB/);
  });
});

describe("THINKING_LEVEL", () => {
  it("accepts the Pi thinking levels and rejects anything else", () => {
    expect(loadConfig({ THINKING_LEVEL: "xhigh" }).thinkingLevel).toBe("xhigh");
    expect(loadConfig({ THINKING_LEVEL: "off" }).thinkingLevel).toBe("off");
    expect(() => loadConfig({ THINKING_LEVEL: "ultra" })).toThrow(/THINKING_LEVEL/);
  });
});

