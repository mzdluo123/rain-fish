import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "bun:test";
import { createAgent } from "../src/agent.js";
import { RunBudget } from "../src/run-budget.js";
import { makeEnv, testModelRuntime } from "./helpers.js";

async function tool(env: ReturnType<typeof makeEnv>, name: string) {
  const { session } = await createAgent(env);
  return session.agent.state.tools.find((t) => t.name === name)!;
}

describe("send tool", () => {
  it("posts the trimmed text with the quoted id, and does not end the run", async () => {
    const env = makeEnv();
    const res = await (await tool(env, "send")).execute("t", { text: "  好的~\n", reply_to: " 4567 " } as never);
    expect(env.sent).toEqual([{ text: "好的~", replyTo: "4567" }]);
    expect(res.terminate).toBeUndefined();
  });

  it("does not quote unless asked", async () => {
    const env = makeEnv();
    await (await tool(env, "send")).execute("t", { text: "hi", reply_to: "  " } as never);
    expect(env.sent).toEqual([{ text: "hi", replyTo: undefined }]);
  });

  it("rejects blank text without sending", async () => {
    const env = makeEnv();
    await expect((await tool(env, "send")).execute("t", { text: " \n" } as never)).rejects.toThrow(/empty/);
    expect(env.sent).toEqual([]);
  });

  it("a failed delivery is an error, so the agent can retry", async () => {
    const env = makeEnv("# P", "offline");
    await expect((await tool(env, "send")).execute("t", { text: "hi" } as never)).rejects.toThrow("offline");
  });

  it("is limited per run (failed sends do not count) and the limit is lifted by reset", async () => {
    const env = { ...makeEnv(), budget: new RunBudget(2, 0) };
    const send = await tool(env, "send");
    await send.execute("t", { text: "1" } as never);
    await send.execute("t", { text: "2" } as never);
    await expect(send.execute("t", { text: "3" } as never)).rejects.toThrow(/at most 2 messages/);
    expect(env.sent).toHaveLength(2);
    env.budget.reset();
    await send.execute("t", { text: "3" } as never);
    expect(env.sent).toHaveLength(3);
  });

  it("waits between the messages of a run", async () => {
    const waits: number[] = [];
    const env = { ...makeEnv(), budget: new RunBudget(6, 700, async (ms) => void waits.push(ms)) };
    const send = await tool(env, "send");
    await send.execute("t", { text: "1" } as never);
    await send.execute("t", { text: "2" } as never);
    expect(waits).toEqual([700]);
  });

  it("output tools run one at a time, in call order", async () => {
    const env = makeEnv();
    for (const n of ["send", "send_image", "stop"]) expect((await tool(env, n)).executionMode).toBe("sequential");
  });
});

describe("stop tool", () => {
  it("ends the run", async () => {
    const res = await (await tool(makeEnv(), "stop")).execute("t", {} as never);
    expect(res.terminate).toBe(true);
  });
});

async function faux() {
  const f = fauxProvider();
  const runtime = await testModelRuntime();
  runtime.registerNativeProvider(f.provider);
  const env = makeEnv();
  const { session } = await createAgent({ ...env, model: f.getModel(), modelRuntime: runtime });
  return { f, env, session };
}

describe("a run with several messages", () => {
  it("send does not end the run; stop does", async () => {
    const { f, env, session } = await faux();
    f.setResponses([
      fauxAssistantMessage(fauxToolCall("send", { text: "第一条" }), { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("send", { text: "第二条" }), fauxToolCall("stop", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("THIS MUST NEVER BE REQUESTED"),
    ]);
    await session.prompt("[t · #7] Alice(42):\n在吗");
    expect(env.sent.map((s) => s.text)).toEqual(["第一条", "第二条"]);
    expect(f.state.callCount).toBe(2);
    expect(f.getPendingResponseCount()).toBe(1);

    f.setResponses([fauxAssistantMessage("不说话", { stopReason: "stop" })]);
    await session.prompt("[t · #8] Bob(43):\n闲聊");
    expect(f.state.callCount).toBe(3);
    expect(env.sent).toHaveLength(2);
  });

  it("[send, send, stop] in one assistant message posts in order and ends without another model call", async () => {
    const { f, env, session } = await faux();
    f.setResponses([
      fauxAssistantMessage([fauxToolCall("send", { text: "A" }), fauxToolCall("send", { text: "B" }), fauxToolCall("send", { text: "C" }), fauxToolCall("stop", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("THIS MUST NEVER BE REQUESTED"),
    ]);
    await session.prompt("hi");
    expect(env.sent.map((s) => s.text)).toEqual(["A", "B", "C"]);
    expect(f.state.callCount).toBe(1);
  });

  it("when a send in the batch fails (here: blank text), the run goes on so the agent can retry", async () => {
    const { f, env, session } = await faux();
    f.setResponses([
      fauxAssistantMessage([fauxToolCall("send", { text: "ok" }), fauxToolCall("send", { text: "  " }), fauxToolCall("stop", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("send", { text: "再试一次" }), fauxToolCall("stop", {})], { stopReason: "toolUse" }),
    ]);
    await session.prompt("hi");
    expect(f.state.callCount).toBe(2);
    expect(env.sent.map((s) => s.text)).toEqual(["ok", "再试一次"]);
  });

  it("a batch with a write blocks send/send_image/stop (nothing is posted); they work in a later step", async () => {
    const { f, env, session } = await faux();
    f.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "/n.md", content: "x" }), fauxToolCall("send", { text: "早了" }), fauxToolCall("stop", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("send", { text: "写好了" }), fauxToolCall("stop", {})], { stopReason: "toolUse" }),
    ]);
    await session.prompt("hi");
    expect(env.fs.readText("/n.md")).toBe("x");
    expect(env.sent.map((s) => s.text)).toEqual(["写好了"]);
    expect(f.state.callCount).toBe(2);
  });

  it("send_image posts a stored picture of this group; unknown ids are an error", async () => {
    const { f, env, session } = await faux();
    const id = env.images.put("100", "m1", 0, Buffer.from([0xff, 0xd8, 0xff, 1]), "image/jpeg");
    f.setResponses([
      fauxAssistantMessage([fauxToolCall("send_image", { image_id: `i${id}`, text: "看这个", reply_to: "9" }), fauxToolCall("stop", {})], { stopReason: "toolUse" }),
    ]);
    await session.prompt("hi");
    expect(env.sentImages).toEqual([{ imageId: id, text: "看这个", replyTo: "9" }]);
    const t = session.agent.state.tools.find((x) => x.name === "send_image")!;
    await expect(t.execute("t", { image_id: "banana" } as never)).rejects.toThrow(/not a picture id/);
  });
});
