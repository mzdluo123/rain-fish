import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("has working defaults", () => {
    expect(loadConfig({})).toEqual({ wsUrl: "ws://127.0.0.1:3001", token: undefined, groups: undefined, promptFile: "prompts/agent.md", dbPath: "data/bot.db", logLevel: "info", model: undefined, context: { recentTokens: 12_000, pruneMinTokens: 800, compactTokens: 60_000, archiveTokens: 20_000 } });
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
    expect(c.context).toEqual({ recentTokens: 8000, pruneMinTokens: 800, compactTokens: 90_000, archiveTokens: 20_000 });
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
