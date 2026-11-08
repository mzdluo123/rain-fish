import { AuthStorage, getAgentDir, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import path from "node:path";

/** The same registry Pi builds by default (credentials in ~/.pi/agent), shared so model lookup and the session agree. */
export function createModelRegistry(): ModelRegistry {
  const dir = getAgentDir();
  return ModelRegistry.create(AuthStorage.create(path.join(dir, "auth.json")), path.join(dir, "models.json"));
}

/** `provider/model-id` -> model. Throws with the available choices when it does not exist. */
export function resolveModel(registry: ModelRegistry, spec: string): Model<Api> {
  const slash = spec.indexOf("/");
  const model = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
  if (model) return model;
  const usable = registry
    .getAvailable()
    .map((m) => `${m.provider}/${m.id}`)
    .slice(0, 15);
  throw new Error(
    `Unknown MODEL "${spec}".` + (usable.length ? ` Some known models: ${usable.join(", ")}` : " No models are available."),
  );
}
