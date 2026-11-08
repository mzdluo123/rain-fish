import { describe, expect, it } from "bun:test";
import { createAgent } from "../src/agent.js";
import { fauxProvider } from "@earendil-works/pi-ai";
import { makeEnv, testModelRuntime } from "./helpers.js";

async function setup() {
  const env = makeEnv();
  env.store.insert({ platform: "qq", groupId: "100", messageId: "1", userId: "42", nickname: "Alice", ts: Date.parse("2026-11-02T12:00:00Z") / 1000, text: "周末一起喝热牛奶吧" });
  env.store.insert({ platform: "qq", groupId: "100", messageId: "2", userId: "43", nickname: "Bob", ts: Date.parse("2026-11-05T12:00:00Z") / 1000, text: "牛奶太甜了" });
  env.store.insert({ platform: "qq", groupId: "200", messageId: "3", userId: "44", nickname: "Eve", ts: Date.parse("2026-11-05T13:00:00Z") / 1000, text: "别的群的牛奶秘密" });
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
    expect(all).toContain("Alice (42): 周末一起喝热牛奶吧");
    expect(all).toContain("Bob (43)");
    expect(await run({ query: "牛奶", sender: "Bob" })).not.toContain("Alice");
    expect(all).not.toContain("Eve"); // another group's history is out of reach
    expect(await run({ query: "秘密", group_id: "200" })).toBe("No matching messages."); // and cannot be asked for
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

describe("search_messages with pictures", () => {
  it("lists the picture ids of a hit and filters by with_images", async () => {
    const env = makeEnv();
    env.store.insert({ platform: "qq", groupId: "100", messageId: "1", userId: "42", nickname: "Alice", ts: 1_700_000_000, text: "看我家的猫[图片]" });
    env.store.insert({ platform: "qq", groupId: "100", messageId: "2", userId: "43", nickname: "Bob", ts: 1_700_000_100, text: "猫好可爱" });
    const id = env.images.put("100", "1", 0, Buffer.from([1, 2, 3]), "image/png");
    const { session } = await createAgent(env);
    const tool = session.agent.state.tools.find((t) => t.name === "search_messages")!;
    const text = async (args: object) => (await tool.execute("t", args as never)).content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(await text({ query: "猫" })).toContain(`[图片: i${id}]`);
    const only = await text({ query: "猫", with_images: true });
    expect(only).toContain("Alice");
    expect(only).not.toContain("Bob");
  });
});

describe("view_image tool", () => {
  it("returns a stored picture of this group as an image block; other groups' and unknown ids are errors", async () => {
    const env = makeEnv();
    const mine = env.images.put("100", "1", 0, Buffer.from([0xff, 0xd8, 0xff, 7]), "image/jpeg");
    const theirs = env.images.put("200", "1", 0, Buffer.from([0xff, 0xd8, 0xff, 8]), "image/jpeg");
    const faux = fauxProvider();
    const runtime = await testModelRuntime();
    runtime.registerNativeProvider(faux.provider);
    const { session } = await createAgent({ ...env, model: faux.getModel(), modelRuntime: runtime });
    const view = session.agent.state.tools.find((t) => t.name === "view_image")!;
    if (!session.model?.input.includes("image")) return; // the faux model decides whether it reads pictures
    const res = await view.execute("t", { image_id: `i${mine}` } as never);
    expect(res.content.some((c) => c.type === "image" && c.mimeType === "image/jpeg")).toBe(true);
    await expect(view.execute("t", { image_id: `i${theirs}` } as never)).rejects.toThrow(/No picture/);
    await expect(view.execute("t", { image_id: "i9999" } as never)).rejects.toThrow(/No picture/);
  });
});
