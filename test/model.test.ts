import { describe, expect, it } from "bun:test";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "../src/model.js";

const registry = () => ModelRegistry.inMemory(AuthStorage.inMemory({ openai: { type: "api_key", key: "sk-test" } }));

describe("resolveModel", () => {
  it("resolves provider/model-id, including ids that contain slashes", () => {
    const r = registry();
    const any = r.getAll().find((m) => m.provider === "openai")!;
    expect(resolveModel(r, `openai/${any.id}`)).toMatchObject({ provider: "openai", id: any.id });
    const slashed = r.getAll().find((m) => m.id.includes("/"));
    if (slashed) expect(resolveModel(r, `${slashed.provider}/${slashed.id}`).id).toBe(slashed.id);
  });

  it("fails with a helpful message for an unknown model, listing models that have credentials", () => {
    expect(() => resolveModel(registry(), "openai/definitely-not-a-model")).toThrow(/Unknown MODEL "openai\/definitely-not-a-model".*openai\//);
    expect(() => resolveModel(registry(), "nope/x")).toThrow(/Unknown MODEL/);
  });
});
