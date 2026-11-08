/**
 * Zod schemas for everything that crosses the OneBot v11 / NapCat WebSocket boundary.
 * Wire types are derived from these in `../types.ts`; nothing else in the program
 * may touch raw frames. Reference: https://napneko.github.io/onebot/event and /segment
 */
import { z } from "zod";

/** QQ numbers and message ids arrive as numbers or strings; the core always uses strings. */
const idSchema = z.union([z.number(), z.string().min(1)]).transform(String);

// ---- message segments (received) -------------------------------------------------
// Known segments validate only the fields we use; extra fields NapCat adds are stripped.
// A known type with malformed data (or an unknown type) degrades to `unknown`, never fails the event.

const empty = z.looseObject({});
const textSegment = z.object({ type: z.literal("text"), data: z.object({ text: z.string() }) });
const atSegment = z.object({ type: z.literal("at"), data: z.object({ qq: idSchema, name: z.string().optional() }) });
const replySegment = z.object({ type: z.literal("reply"), data: z.object({ id: idSchema }) });
/** Pictures (`image` photos and stickers, `mface` market stickers): only `url` is used; without one the segment is the plain `simple` variant below and stays a text placeholder. */
const picture = <T extends string>(type: T) => z.object({ type: z.literal(type), data: z.object({ url: z.string().min(1) }) });
const simple = <T extends string>(type: T) => z.object({ type: z.literal(type), data: empty });
const unknownSegment = z
  .object({ type: z.string(), data: empty.optional() })
  .transform((s) => ({ type: "unknown" as const, original: s.type }));

export const segmentSchema = z.union([
  textSegment,
  atSegment,
  replySegment,
  picture("image"),
  picture("mface"),
  simple("face"),
  simple("mface"),
  simple("dice"),
  simple("rps"),
  simple("poke"),
  simple("image"),
  simple("record"),
  simple("video"),
  simple("file"),
  simple("json"),
  simple("forward"),
  unknownSegment,
]);

// ---- message segments (sent) -----------------------------------------------------

export const outboundSegmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), data: z.object({ text: z.string().min(1) }) }),
  z.object({ type: z.literal("reply"), data: z.object({ id: z.string().regex(/^-?\d+$/) }) }),
]);

// ---- CQ-code string format -------------------------------------------------------
// NapCat's `messagePostFormat: "string"`. Converted to raw segments, then validated like array format.

const unescapeCq = (s: string) =>
  s.replaceAll("&#91;", "[").replaceAll("&#93;", "]").replaceAll("&#44;", ",").replaceAll("&amp;", "&");

function cqToSegments(s: string): unknown[] {
  const out: unknown[] = [];
  let last = 0;
  const pushText = (t: string) => t && out.push({ type: "text", data: { text: unescapeCq(t) } });
  for (const m of s.matchAll(/\[CQ:(\w+)((?:,[^\]]*)?)\]/g)) {
    pushText(s.slice(last, m.index));
    const data: Record<string, string> = {};
    for (const pair of m[2]!.split(",").filter(Boolean)) {
      const eq = pair.indexOf("=");
      if (eq > 0) data[pair.slice(0, eq)] = unescapeCq(pair.slice(eq + 1));
    }
    out.push({ type: m[1], data });
    last = m.index + m[0].length;
  }
  pushText(s.slice(last));
  return out;
}

const messageSchema = z.union([z.array(segmentSchema), z.string().transform(cqToSegments).pipe(z.array(segmentSchema))]);

// ---- events ----------------------------------------------------------------------

/** `message` (received) and `message_sent` (the bot's own messages) in a group. */
export const groupMessageEventSchema = z.object({
  post_type: z.enum(["message", "message_sent"]),
  message_type: z.literal("group"),
  self_id: idSchema,
  time: z.number().int().nonnegative(),
  message_id: idSchema,
  group_id: idSchema,
  user_id: idSchema,
  message: messageSchema,
  sender: z
    .object({
      nickname: z.string().optional(),
      card: z.string().optional(),
    })
    .optional(),
});

export const lifecycleEventSchema = z.object({
  post_type: z.literal("meta_event"),
  meta_event_type: z.literal("lifecycle"),
  self_id: idSchema,
  sub_type: z.string(),
});

/** Only used to route a frame: which family of event is this? */
export const eventHeadSchema = z.object({
  post_type: z.string(),
  message_type: z.string().optional(),
  meta_event_type: z.string().optional(),
});

// ---- API request / response ------------------------------------------------------

export const apiResponseSchema = z.object({
  status: z.string(),
  retcode: z.number(),
  data: z.unknown().optional(),
  message: z.string().optional(),
  wording: z.string().optional(),
  echo: z.union([z.string(), z.number()]).transform(String),
});

export const sendGroupMsgRequestSchema = z.object({
  action: z.literal("send_group_msg"),
  params: z.object({
    group_id: z.string().regex(/^\d+$/).transform(Number),
    message: z.array(outboundSegmentSchema).min(1),
  }),
  echo: z.string().min(1),
});

export const sendGroupMsgDataSchema = z.object({ message_id: idSchema });

// History backfill. Items of `get_group_msg_history` look like message events, but NapCat may leave out
// `post_type`/`message_type`/`self_id`/`group_id` there; the client fills them in from what it asked for.
export const historyMessageSchema = groupMessageEventSchema.extend({
  post_type: z.enum(["message", "message_sent"]).default("message"),
  message_type: z.literal("group").default("group"),
  self_id: idSchema.optional(),
  group_id: idSchema.optional(),
  message_seq: idSchema.optional(),
});

export const getGroupMsgHistoryRequestSchema = z.object({
  action: z.literal("get_group_msg_history"),
  params: z.object({
    group_id: z.string().regex(/^\d+$/).transform(Number),
    /** Newest seq to return (going older); omitted = the latest messages. */
    message_seq: z.string().regex(/^\d+$/).transform(Number).optional(),
    count: z.number().int().positive(),
  }),
  echo: z.string().min(1),
});

/** Items are validated one by one by the caller, so one odd message does not discard the page. */
export const getGroupMsgHistoryDataSchema = z.object({ messages: z.array(z.unknown()) });

export const getGroupListRequestSchema = z.object({ action: z.literal("get_group_list"), params: z.object({}), echo: z.string().min(1) });

export const getGroupListDataSchema = z.array(z.object({ group_id: idSchema }));
