import { describe, expect, it } from "bun:test";
import { createAgent } from "../src/agent.js";
import { makeEnv } from "./helpers.js";

async function setup() {
  const env = makeEnv();
  env.store.insert({ platform: "qq", groupId: "100", messageId: "1", userId: "42", nickname: "Alice", ts: Date.parse("2026-11-02T12:00:00Z") / 1000, text: "周末一起喝热牛奶吧" });
  env.store.insert({ platform: "qq", groupId: "100", messageId: "2", userId: "43", nickname: "Bob", ts: Date.parse("2026-11-05T12:00:00Z") / 1000, text: "牛奶太甜了" });
  const { session } = await createAgent(env);
  const tool = session.agent.state.tools.find((t) => t.name === "search_messages")!;
  const run = async (args: Record<string, unknown>) =>
    (await tool.execute("t", args as never)).content.map((c) => (c.type === "text" ? c.text : "")).join("");
  return { run };
}

describe("search_messages tool", () => {
  it("returns formatted hits, honours sender and date filters", async () => {
    const { run } = await setup();
    const all = await run({ query: "牛奶" });
    expect(all).toContain("Alice (42) in group 100: 周末一起喝热牛奶吧");
    expect(all).toContain("Bob (43)");
    expect(await run({ query: "牛奶", sender: "Bob" })).not.toContain("Alice");
    const late = await run({ query: "牛奶", since: "2026-11-04" });
    expect(late).toContain("Bob");
    expect(late).not.toContain("Alice");
    expect(await run({ query: "不存在的词" })).toBe("No matching messages.");
  });

  it("rejects an unparseable date instead of silently ignoring the filter", async () => {
    const { run } = await setup();
    await expect(run({ query: "牛奶", since: "last tuesday" })).rejects.toThrow(/Invalid since date/);
  });
});
