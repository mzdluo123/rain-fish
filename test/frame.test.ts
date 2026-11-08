import { describe, expect, it } from "bun:test";
import { parseFrame } from "../src/qq/frame.js";

const group = {
  post_type: "message",
  message_type: "group",
  sub_type: "normal",
  message_id: 12345,
  group_id: 100200,
  user_id: 42,
  self_id: 10001,
  time: 1_700_000_000,
  raw_message: "ignored",
  sender: { user_id: 42, nickname: "Alice", card: "", role: "member" },
  anonymous: null,
  font: 14,
};
const seg = (type: string, data: unknown) => ({ type, data });
const parse = (o: unknown) => parseFrame(JSON.stringify(o));

describe("parseFrame: group messages", () => {
  it("validates array-format messages and normalises ids to strings", () => {
    const f = parse({ ...group, message: [seg("text", { text: "hi" }), seg("at", { qq: 10001 })] });
    expect(f.kind).toBe("group_message");
    if (f.kind !== "group_message") return;
    expect(f.event.group_id).toBe("100200");
    expect(f.event.message_id).toBe("12345");
    expect(f.event.message).toEqual([
      { type: "text", data: { text: "hi" } },
      { type: "at", data: { qq: "10001" } },
    ]);
    expect("raw_message" in f.event).toBe(false); // unvalidated extras never pass the edge
  });

  it("accepts CQ-code string format, unescaping entities", () => {
    const f = parse({ ...group, message: "a &#91;x&#93; &amp; b [CQ:at,qq=7] [CQ:image,file=x.jpg,url=http://a/b?c=1&amp;d=2]" });
    if (f.kind !== "group_message") throw new Error(f.kind);
    expect(f.event.message).toEqual([
      { type: "text", data: { text: "a [x] & b " } },
      { type: "at", data: { qq: "7" } },
      { type: "text", data: { text: " " } },
      { type: "image", data: expect.anything() },
    ]);
  });

  it("degrades unknown or malformed segments instead of rejecting the message", () => {
    const f = parse({ ...group, message: [seg("shake", {}), seg("text", { text: 5 }), { type: "markdown" }] });
    if (f.kind !== "group_message") throw new Error(f.kind);
    expect(f.event.message).toEqual([
      { type: "unknown", original: "shake" },
      { type: "unknown", original: "text" },
      { type: "unknown", original: "markdown" },
    ]);
  });

  it("accepts message_sent from the bot itself", () => {
    expect(parse({ ...group, post_type: "message_sent", message: [seg("text", { text: "yo" })] }).kind).toBe("group_message");
  });

  it("rejects group messages with missing or wrongly typed required fields", () => {
    const ok = { ...group, message: [seg("text", { text: "hi" })] };
    for (const bad of [
      { ...ok, group_id: undefined },
      { ...ok, user_id: null },
      { ...ok, message_id: "" },
      { ...ok, time: "yesterday" },
      { ...ok, time: -1 },
      { ...ok, message: { type: "text" } },
      { ...ok, self_id: undefined },
    ]) {
      expect(parse(bad).kind).toBe("invalid");
    }
  });
});

describe("parseFrame: everything else", () => {
  it("returns lifecycle, ignores heartbeats, notices, requests and private messages", () => {
    expect(parse({ post_type: "meta_event", meta_event_type: "lifecycle", sub_type: "connect", self_id: 10001, time: 1 })).toEqual({
      kind: "lifecycle",
      selfId: "10001",
      subType: "connect",
    });
    expect(parse({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: 1, time: 1 }).kind).toBe("ignored");
    expect(parse({ post_type: "notice", notice_type: "group_recall" }).kind).toBe("ignored");
    expect(parse({ post_type: "request", request_type: "friend" }).kind).toBe("ignored");
    expect(parse({ ...group, message_type: "private", message: "hi" }).kind).toBe("ignored");
  });

  it("parses API responses and coerces echo to string", () => {
    expect(parse({ status: "ok", retcode: 0, data: { message_id: 9 }, echo: 7 })).toEqual({
      kind: "api_response",
      response: { status: "ok", retcode: 0, data: { message_id: 9 }, echo: "7" },
    });
    expect(parse({ status: "ok", retcode: "0", echo: "a" }).kind).toBe("invalid");
  });

  it("never throws: garbage becomes invalid", () => {
    for (const raw of ["", "not json", "null", "42", "[]", '"str"', "{}", '{"post_type":5}']) {
      expect(parseFrame(raw).kind).toBe("invalid");
    }
  });
});
