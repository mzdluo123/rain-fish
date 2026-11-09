import type { Frame } from "../types.js";
import { apiResponseSchema, eventHeadSchema, groupMessageEventSchema, lifecycleEventSchema, pokeEventSchema } from "./schemas.js";

const summarize = (issues: readonly { path: PropertyKey[]; message: string }[]) =>
  issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");

/**
 * The WebSocket edge: turns one raw text frame into a validated `Frame`.
 * Never throws; anything malformed becomes `{ kind: "invalid" }` and is dropped by the caller.
 */
export function parseFrame(raw: string): Frame {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "not JSON" };
  }

  // API responses carry `echo` + `retcode`; events never do.
  if (typeof json === "object" && json !== null && "retcode" in json) {
    const r = apiResponseSchema.safeParse(json);
    return r.success ? { kind: "api_response", response: r.data } : { kind: "invalid", reason: `api response: ${summarize(r.error.issues)}` };
  }

  const head = eventHeadSchema.safeParse(json);
  if (!head.success) return { kind: "invalid", reason: `unrecognised frame: ${summarize(head.error.issues)}` };
  const { post_type, message_type, meta_event_type, notice_type, sub_type, group_id } = head.data;

  if ((post_type === "message" || post_type === "message_sent") && message_type === "group") {
    const r = groupMessageEventSchema.safeParse(json);
    return r.success ? { kind: "group_message", event: r.data } : { kind: "invalid", reason: `group message: ${summarize(r.error.issues)}` };
  }
  if (post_type === "meta_event" && meta_event_type === "lifecycle") {
    const r = lifecycleEventSchema.safeParse(json);
    return r.success ? { kind: "lifecycle", selfId: r.data.self_id, subType: r.data.sub_type } : { kind: "invalid", reason: `lifecycle: ${summarize(r.error.issues)}` };
  }
  if (post_type === "notice" && notice_type === "notify" && sub_type === "poke" && group_id !== undefined) {
    const r = pokeEventSchema.safeParse(json);
    return r.success ? { kind: "group_poke", event: r.data } : { kind: "invalid", reason: `group poke: ${summarize(r.error.issues)}` };
  }
  // heartbeat, other notices, request, private messages (and private pokes): not used by the bot.
  return { kind: "ignored" };
}
