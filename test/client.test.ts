import { afterEach, describe, expect, it } from "bun:test";
import { OneBotClient } from "../src/qq/client.js";
import type { GroupMessage } from "../src/types.js";
import { recordingLogger } from "./helpers.js";

const groupEvent = (id: number, group: number, text: string) => ({
  post_type: "message", message_type: "group", message_id: id, group_id: group, user_id: 1, self_id: 10001,
  time: 1_700_000_000 + id, sender: { nickname: "Alice" }, message: [{ type: "text", data: { text } }],
});

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

type Sock = { send(s: string): void; close(): void };
interface FakeOpts { port?: number; onOpen?(ws: Sock): void; onMessage?(ws: Sock, data: string): void; onHeaders?(h: Headers): void }

/** A fake NapCat: a WebSocket server the client under test connects to. */
function fakeNapCat(o: FakeOpts = {}) {
  const server = Bun.serve({
    port: o.port ?? 0,
    fetch(req, srv) {
      o.onHeaders?.(req.headers);
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: { open: (ws) => o.onOpen?.(ws), message: (ws, m) => o.onMessage?.(ws, String(m)) },
  });
  cleanup.push(() => server.stop(true));
  return server;
}

function connect(port: number, extra: Partial<ConstructorParameters<typeof OneBotClient>[0]> = {}) {
  const received: GroupMessage[] = [];
  const rec = recordingLogger();
  const logs = rec.messages;
  const client = new OneBotClient({ url: `ws://localhost:${port}`, onGroupMessage: (m) => void received.push(m), logger: rec.logger, minBackoffMs: 20, maxBackoffMs: 50, ...extra });
  client.start();
  cleanup.push(() => client.stop());
  return { client, received, logs, entries: rec.entries };
}

describe("receiving", () => {
  it("hands only validated, converted group messages to the core, and sends the token", async () => {
    const seen = { auth: null as string | null };
    const server = fakeNapCat({
      onHeaders: (h) => (seen.auth = h.get("authorization")),
      onOpen(ws) {
        ws.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: 1, time: 1 }));
        ws.send("not json");
        ws.send(JSON.stringify({ ...groupEvent(0, 100, "x"), group_id: "nope-not-a-number-but-valid-string" }));
        ws.send(JSON.stringify({ ...groupEvent(9, 100, "bad"), time: "yesterday" })); // invalid
        ws.send(JSON.stringify(groupEvent(1, 100, "群里讨论牛奶")));
      },
    });
    const { received, logs, entries } = connect(server.port!, { token: "secret" });
    await until(() => received.some((m) => m.messageId === "1"));
    expect(received.map((m) => m.messageId).sort()).toEqual(["0", "1"]); // the `time: "yesterday"` event never arrived
    expect(received.find((m) => m.messageId === "1")).toMatchObject({ groupId: "100", text: "群里讨论牛奶", selfId: "10001" });
    expect(entries).toContainEqual({ level: "warn", msg: expect.stringContaining("dropped invalid frame: group message: time") });
    expect(entries).toContainEqual({ level: "success", msg: expect.stringContaining("connected to ws://") });
    expect(seen.auth).toBe("Bearer secret");
  });

  it("a throwing handler does not break the connection", async () => {
    const server = fakeNapCat({ onOpen(ws) { ws.send(JSON.stringify(groupEvent(1, 1, "a"))); ws.send(JSON.stringify(groupEvent(2, 1, "b"))); } });
    const seen: string[] = [];
    const { entries } = connect(server.port!, { onGroupMessage: (m) => { seen.push(m.text); throw new Error("boom"); } });
    await until(() => seen.length === 2);
    expect(entries.filter((e) => e.level === "error" && e.msg.includes("handler error: boom"))).toHaveLength(2);
  });

  it("keeps retrying until the server is up, then receives", async () => {
    const probe = fakeNapCat();
    const port = probe.port!;
    probe.stop(true);
    const { received } = connect(port);
    await Bun.sleep(150);
    fakeNapCat({ port, onOpen: (ws) => ws.send(JSON.stringify(groupEvent(5, 100, "迟到的消息"))) });
    await until(() => received.length === 1);
  });
});

describe("sendGroupMessage", () => {
  const reply = (ws: Sock, data: string, body: object) => ws.send(JSON.stringify({ ...JSON.parse(data), ...body }));

  it("sends a validated send_group_msg request and resolves with the message id", async () => {
    const requests: unknown[] = [];
    const server = fakeNapCat({
      onMessage(ws, data) {
        const req = JSON.parse(data);
        requests.push(req);
        ws.send(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 555 }, echo: req.echo }));
      },
    });
    const { client, logs } = connect(server.port!);
    await until(() => logs.some((l) => l.startsWith("connected")));
    const res = await client.sendGroupMessage("100200", [{ type: "reply", data: { id: "9" } }, { type: "text", data: { text: "你好" } }]);
    expect(res).toEqual({ messageId: "555" });
    expect(requests[0]).toMatchObject({
      action: "send_group_msg",
      params: { group_id: 100200, message: [{ type: "reply", data: { id: "9" } }, { type: "text", data: { text: "你好" } }] },
    });
  });

  it("matches concurrent responses by echo, even out of order", async () => {
    const held: { ws: Sock; echo: string; text: string }[] = [];
    const server = fakeNapCat({
      onMessage(ws, data) {
        const req = JSON.parse(data);
        held.push({ ws, echo: req.echo, text: req.params.message[0].data.text });
        if (held.length === 2) for (const h of [...held].reverse()) h.ws.send(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: h.text === "a" ? 1 : 2 }, echo: h.echo }));
      },
    });
    const { client, logs } = connect(server.port!);
    await until(() => logs.some((l) => l.startsWith("connected")));
    const [a, b] = await Promise.all([
      client.sendGroupMessage("1", [{ type: "text", data: { text: "a" } }]),
      client.sendGroupMessage("1", [{ type: "text", data: { text: "b" } }]),
    ]);
    expect([a.messageId, b.messageId]).toEqual(["1", "2"]);
  });

  it("rejects on a failed retcode, on a malformed success payload, and on timeout", async () => {
    let mode = "fail";
    const server = fakeNapCat({
      onMessage(ws, data) {
        if (mode === "fail") reply(ws, data, { status: "failed", retcode: 1200, wording: "不在群里" });
        else if (mode === "badpayload") reply(ws, data, { status: "ok", retcode: 0, data: { nope: 1 } });
      },
    });
    const { client, logs } = connect(server.port!, { requestTimeoutMs: 100 });
    await until(() => logs.some((l) => l.startsWith("connected")));
    const msg = [{ type: "text" as const, data: { text: "x" } }];
    await expect(client.sendGroupMessage("1", msg)).rejects.toThrow(/retcode 1200.*不在群里/);
    mode = "badpayload";
    await expect(client.sendGroupMessage("1", msg)).rejects.toThrow();
    mode = "silent";
    await expect(client.sendGroupMessage("1", msg)).rejects.toThrow(/timed out/);
  });

  it("refuses invalid outbound data before anything is sent", async () => {
    const sent: string[] = [];
    const server = fakeNapCat({ onMessage: (_ws, d) => sent.push(d) });
    const { client, logs } = connect(server.port!);
    await until(() => logs.some((l) => l.startsWith("connected")));
    await expect(client.sendGroupMessage("not-a-number", [{ type: "text", data: { text: "x" } }])).rejects.toThrow();
    await expect(client.sendGroupMessage("1", [])).rejects.toThrow();
    await expect(client.sendGroupMessage("1", [{ type: "text", data: { text: "" } }])).rejects.toThrow();
    await Bun.sleep(50);
    expect(sent).toEqual([]);
  });

  it("rejects when not connected, and fails in-flight requests when the connection drops", async () => {
    const probe = fakeNapCat();
    const port = probe.port!;
    probe.stop(true);
    const offline = connect(port);
    await expect(offline.client.sendGroupMessage("1", [{ type: "text", data: { text: "x" } }])).rejects.toThrow(/not connected/);

    const server = fakeNapCat({ onMessage: (ws) => ws.close() }); // never answers, hangs up
    const { client, logs } = connect(server.port!);
    await until(() => logs.some((l) => l.startsWith("connected")));
    await expect(client.sendGroupMessage("1", [{ type: "text", data: { text: "x" } }])).rejects.toThrow(/connection closed/);
  });
});

describe("history API", () => {
  const item = (seq: number, extra: object = {}) => ({
    message_seq: seq, message_id: 9000 + seq, group_id: 100, user_id: 42, time: 1_700_000_000 + seq,
    sender: { nickname: "Alice" }, message: [{ type: "text", data: { text: `历史${seq}` } }], ...extra,
  });

  it("get_group_msg_history: sends the paging request and converts items, filling fields NapCat leaves out and skipping bad items", async () => {
    const requests: any[] = [];
    const server = fakeNapCat({
      onMessage(ws, data) {
        const req = JSON.parse(data);
        requests.push(req);
        const messages = [item(7), { ...item(5), self_id: 10001 }, item(6, { message: [] }), { nonsense: true }, item(4, { group_id: undefined })];
        ws.send(JSON.stringify({ status: "ok", retcode: 0, data: { messages }, echo: req.echo }));
      },
    });
    const { client, logs, entries } = connect(server.port!);
    await until(() => logs.some((l) => l.startsWith("connected")));
    const page = await client.getGroupHistory("100", "8", 100);
    expect(requests[0]).toMatchObject({ action: "get_group_msg_history", params: { group_id: 100, message_seq: 8, count: 100 } });
    expect(page.messages.map((m) => [m.messageId, m.groupId, m.text])).toEqual([
      ["9004", "100", "历史4"], // group_id filled from the request
      ["9005", "100", "历史5"],
      ["9007", "100", "历史7"], // sorted oldest first; the item without text (6) is dropped
    ]);
    expect(page.oldest).toEqual({ seq: "4", ts: 1_700_000_004 }); // the cursor for the next, older page
    expect(entries.some((e) => e.level === "warn" && e.msg.includes("skipped 1 invalid"))).toBe(true);

    await client.getGroupHistory("100", undefined, 50);
    expect(requests[1].params.message_seq).toBeUndefined(); // the latest messages
  });

  it("rejects when the API reports a failure", async () => {
    const server = fakeNapCat({ onMessage: (ws, data) => ws.send(JSON.stringify({ status: "failed", retcode: 1200, wording: "no such group", echo: JSON.parse(data).echo })) });
    const { client, logs } = connect(server.port!);
    await until(() => logs.some((l) => l.startsWith("connected")));
    await expect(client.getGroupHistory("100", undefined, 10)).rejects.toThrow(/no such group/);
  });

  it("get_group_list returns the group ids", async () => {
    const server = fakeNapCat({ onMessage: (ws, data) => ws.send(JSON.stringify({ status: "ok", retcode: 0, data: [{ group_id: 100, group_name: "a" }, { group_id: "200" }], echo: JSON.parse(data).echo })) });
    const { client, logs } = connect(server.port!);
    await until(() => logs.some((l) => l.startsWith("connected")));
    expect(await client.getGroupList()).toEqual(["100", "200"]);
  });

  it("calls onConnect each time the socket connects", async () => {
    let n = 0;
    const server = fakeNapCat();
    connect(server.port!, { onConnect: () => void n++ });
    await until(() => n === 1);
  });
});
