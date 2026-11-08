import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { describe, expect, it } from "bun:test";
import { createAgent } from "../src/agent.js";
import { makeEnv } from "./helpers.js";

async function sendTool(env: ReturnType<typeof makeEnv>) {
  const { session } = await createAgent(env);
  return session.agent.state.tools.find((t) => t.name === "send")!;
}

describe("send tool", () => {
  it("posts the trimmed text with the quoted id, and tells the loop to stop", async () => {
    const env = makeEnv();
    const res = await (await sendTool(env)).execute("t", { text: "  好的~\n", reply_to: " 4567 " } as never);
    expect(env.sent).toEqual([{ text: "好的~", replyTo: "4567" }]);
    expect(res.terminate).toBe(true);
  });

  it("does not quote unless asked", async () => {
    const env = makeEnv();
    await (await sendTool(env)).execute("t", { text: "hi", reply_to: "  " } as never);
    expect(env.sent).toEqual([{ text: "hi", replyTo: undefined }]);
  });

  it("rejects blank text without sending or terminating", async () => {
    const env = makeEnv();
    await expect((await sendTool(env)).execute("t", { text: " \n" } as never)).rejects.toThrow(/empty/);
    expect(env.sent).toEqual([]);
  });

  it("a failed delivery is an error, not a terminating success, so the agent can retry", async () => {
    const env = makeEnv("# P", "offline");
    await expect((await sendTool(env)).execute("t", { text: "hi" } as never)).rejects.toThrow("offline");
  });
});

describe("send ends the run", () => {
  it("the model is not called again after a successful send, and the next prompt still works", async () => {
    const faux = registerFauxProvider();
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    registry.registerProvider(faux.models[0].provider, { baseUrl: "http://faux", apiKey: "k", api: faux.api, models: [] });
    const env = makeEnv();
    const { session } = await createAgent({ ...env, model: faux.getModel(), modelRegistry: registry });

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("send", { text: "你好呀", reply_to: "7" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("THIS MUST NEVER BE REQUESTED"),
    ]);
    await session.prompt("[t · #7] Alice(42):\n在吗");
    expect(env.sent).toEqual([{ text: "你好呀", replyTo: "7" }]);
    expect(faux.state.callCount).toBe(1);
    expect(faux.getPendingResponseCount()).toBe(1);

    faux.setResponses([fauxAssistantMessage("不说话", { stopReason: "stop" })]);
    await session.prompt("[t · #8] Bob(43):\n闲聊");
    expect(faux.state.callCount).toBe(2);
    expect(env.sent).toHaveLength(1);
    faux.unregister();
  });
});
