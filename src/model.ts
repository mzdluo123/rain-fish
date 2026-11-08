import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

/** The same runtime Pi builds by default (credentials in ~/.pi/agent, plus its `models.json`), shared so model lookup and the session agree. */
export function createModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create();
}

/** `provider/model-id` -> model. Throws with the available choices when it does not exist. */
export function resolveModel(runtime: ModelRuntime, spec: string): Model<Api> {
  const slash = spec.indexOf("/");
  const model = runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1));
  if (model) return model;
  const usable = runtime
    .getAvailableSnapshot()
    .map((m) => `${m.provider}/${m.id}`)
    .slice(0, 15);
  throw new Error(
    `Unknown MODEL "${spec}".` + (usable.length ? ` Some known models: ${usable.join(", ")}` : " No models are available."),
  );
}
