import { describe, expect, it } from "bun:test";
import { resolveModel } from "../src/model.js";
import { testModelRuntime } from "./helpers.js";

const runtime = testModelRuntime;

describe("resolveModel", () => {
  it("resolves provider/model-id", async () => {
    const rt = await runtime();
    const any = rt.getModels("openai")[0]!;
    expect(resolveModel(rt, `openai/${any.id}`)).toMatchObject({ provider: "openai", id: any.id });
  });

  it("knows Claude Haiku 5.5, with its 1M window", async () => {
    expect(resolveModel(await runtime(), "anthropic/claude-haiku-5-5")).toMatchObject({ id: "claude-haiku-5-5", contextWindow: 1_000_000, reasoning: true });
  });

  it("fails with a helpful message for an unknown model", async () => {
    const rt = await runtime();
    expect(() => resolveModel(rt, "openai/definitely-not-a-model")).toThrow(/Unknown MODEL "openai\/definitely-not-a-model"/);
    expect(() => resolveModel(rt, "nope/x")).toThrow(/Unknown MODEL/);
  });
});
