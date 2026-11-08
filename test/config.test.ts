import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("has working defaults", () => {
    expect(loadConfig({})).toEqual({ wsUrl: "ws://127.0.0.1:3001", token: undefined, groups: undefined, dbPath: "data/bot.db" });
  });

  it("parses the group allowlist, trimming blanks", () => {
    expect(loadConfig({ QQ_GROUPS: " 1, 2 ,,3 " }).groups).toEqual(new Set(["1", "2", "3"]));
    expect(loadConfig({ QQ_GROUPS: " , " }).groups).toBeUndefined();
  });

  it("rejects a non-WebSocket or malformed URL with a readable error", () => {
    expect(() => loadConfig({ QQ_WS_URL: "http://127.0.0.1:3001" })).toThrow(/Invalid configuration.*QQ_WS_URL/);
    expect(() => loadConfig({ QQ_WS_URL: "not a url" })).toThrow(/QQ_WS_URL/);
  });
});
