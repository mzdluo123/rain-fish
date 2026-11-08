import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { isArchiveMessage } from "../src/context/archive.js";
import { PiConversation } from "../src/conversation.js";
import { ConversationStore } from "../src/conversation-store.js";
import { openDb } from "../src/db/open.js";
import type { ContextConfig } from "../src/types.js";
import { assistantCall, assistantError, assistantText, recordingLogger, tokensOf, toolResultMsg } from "./helpers.js";

type Script = (prompt: string, n: number) => AgentMessage[];

/** The slice of AgentSession that PiConversation touches. `script` produces the messages a model turn appends. */
function fakeSession(opts: { vision?: boolean; script?: Script } = {}) {
  const state = { messages: [] as AgentMessage[] };
  let turn = 0;
  const session = {
    state,
    agent: { state, transformContext: undefined as ((m: AgentMessage[], s?: AbortSignal) => Promise<AgentMessage[]>) | undefined },
    model: { api: "openai-responses", id: "gpt-5.5", provider: "openai", input: opts.vision === false ? ["text"] : ["text", "image"] },
    systemPrompt: "",
    async prompt(text: string) {
      state.messages = [...state.messages, { role: "user", content: text, timestamp: Date.now() }, ...(opts.script ?? (() => [assistantText("好的")]))(text, ++turn)];
    },
    getActiveToolNames: () => [],
  };
  return session;
}

// system overhead is ~2.5k tokens, so thresholds are chosen on top of that
const ctx: ContextConfig = { recentTokens: 1500, pruneMinTokens: 400, compactTokens: 6000, archiveTokens: 3000 };

async function setup(over: { vision?: boolean; script?: Script; context?: Partial<ContextConfig>; db?: ReturnType<typeof openDb>; group?: string } = {}) {
  const db = over.db ?? openDb(":memory:");
  const store = new ConversationStore(db);
  const rec = recordingLogger();
  const session = fakeSession(over);
  const conv = await PiConversation.create({ groupId: over.group ?? "g1", session: session as never, store, context: { ...ctx, ...over.context }, logger: rec.logger });
  return { db, store, session, conv, entries: rec.entries };
}
const roles = (s: { state: { messages: AgentMessage[] } }) => s.state.messages.map((m) => (isArchiveMessage(m) ? "archive" : m.role));
const bigScript: Script = (_p, n) => [assistantText(`第${n}轮的回答 ` + tokensOf(380))];

describe("persistence", () => {
  it("returns the reply text and persists the turn; a new conversation resumes from the database", async () => {
    const a = await setup();
    expect(await a.conv.ask("你好")).toBe("好的");
    expect(roles(a.session)).toEqual(["user", "assistant"]);
    expect(a.store.load("g1").messages.map((m) => m.seq)).toEqual([1, 2]);

    const b = await setup({ db: a.db });
    expect(roles(b.session)).toEqual(["user", "assistant"]);
    await b.conv.ask("再来");
    expect(b.store.load("g1").messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
  });

  it("keeps groups apart", async () => {
    const a = await setup({ group: "g1" });
    await a.conv.ask("only g1");
    const b = await setup({ db: a.db, group: "g2" });
    expect(b.session.state.messages).toHaveLength(0);
  });

  it("a failed turn leaves no trace in memory or in the database, and the next turn works", async () => {
    let fail = true;
    const { conv, session, store } = await setup({ script: () => (fail ? [assistantError("rate limited")] : [assistantText("恢复了")]) });
    await expect(conv.ask("hi")).rejects.toThrow("rate limited");
    expect(session.state.messages).toHaveLength(0);
    expect(store.load("g1").messages).toHaveLength(0);
    fail = false;
    expect(await conv.ask("hi again")).toBe("恢复了");
    expect(store.load("g1").messages.map((m) => m.seq)).toEqual([1, 2]);
  });
});

describe("level 1: pruning view", () => {
  it("is installed as transformContext and chains an existing hook", async () => {
    const session = fakeSession();
    let chained = false;
    session.agent.transformContext = async (m) => ((chained = true), m);
    const conv = await PiConversation.create({ groupId: "g", session: session as never, store: new ConversationStore(openDb(":memory:")), context: ctx });
    const msgs: AgentMessage[] = [assistantCall("1", "read", {}), toolResultMsg("1", "read", tokensOf(3000)), assistantText(tokensOf(1600))];
    const view = await session.agent.transformContext!(msgs);
    expect(chained).toBe(true);
    expect(JSON.stringify(view)).toContain("已清理：read");
    expect(JSON.stringify(msgs)).not.toContain("已清理"); // the stored history is not rewritten
    expect(conv).toBeDefined();
  });
});

describe("level 2: snap compaction", () => {
  async function fill(conv: PiConversation, rounds: number) {
    for (let i = 1; i <= rounds; i++) await conv.ask(`第${i}个问题 ` + tokensOf(380));
  }

  it("does nothing below the threshold", async () => {
    const { conv, session, db } = await setup({ script: bigScript });
    await fill(conv, 3);
    expect(roles(session)).not.toContain("archive");
    expect(db.query("SELECT COUNT(*) n FROM agent_archives").get()).toEqual({ n: 0 });
  });

  it("past the threshold, retires old turns into one archive message of image frames and keeps the recent turns", async () => {
    const { conv, session, db, entries } = await setup({ script: bigScript });
    await fill(conv, 8);
    expect(roles(session)[0]).toBe("archive");
    const archive = session.state.messages[0]!;
    const images = archive.role === "user" && Array.isArray(archive.content) ? archive.content.filter((c) => c.type === "image") : [];
    expect(images.length).toBeGreaterThanOrEqual(1);
    // what follows the archive starts at a turn boundary and is a plain alternation of user/assistant
    expect(roles(session)[1]).toBe("user");
    expect(entries.some((e) => e.level === "success" && e.msg.includes("compacted"))).toBe(true);

    const row = db.query("SELECT through_seq, source_text FROM agent_archives WHERE group_id = 'g1'").get() as { through_seq: number; source_text: string };
    expect(row.source_text).toContain("第1个问题"); // the oldest turn lives on in the archive text
    const live = db.query("SELECT MIN(seq) lo FROM agent_messages WHERE group_id = 'g1'").get() as { lo: number };
    expect(live.lo).toBe(row.through_seq + 1); // retired messages are gone from the live table
    expect(session.state.messages.length - 1).toBeLessThan(16);
  });

  it("an interrupted conversation resumes with the same archive + live messages", async () => {
    const a = await setup({ script: bigScript });
    await fill(a.conv, 8);
    const b = await setup({ db: a.db, script: bigScript });
    expect(roles(b.session)).toEqual(roles(a.session));
    await b.conv.ask("重启后的问题");
    const seqs = b.store.load("g1").messages.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y)); // numbering continues, never reused
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("models without image input get a text archive", async () => {
    const { conv, session } = await setup({ vision: false, script: bigScript });
    await fill(conv, 8);
    const archive = session.state.messages[0]!;
    expect(isArchiveMessage(archive)).toBe(true);
    expect(archive.role === "user" && Array.isArray(archive.content) && archive.content.every((c) => c.type === "text")).toBe(true);
    expect(JSON.stringify(archive)).toContain("第");
  });

  it("never splits a tool call from its result: the kept part starts at a user message", async () => {
    const withTools: Script = (_p, n) => [assistantCall(`c${n}`, "read", { path: `/f${n}` }), toolResultMsg(`c${n}`, "read", tokensOf(300)), assistantText(`答${n} ` + tokensOf(300))];
    const { conv, session } = await setup({ script: withTools, context: { pruneMinTokens: 100_000 } });
    await fill(conv, 8);
    const msgs = session.state.messages;
    expect(isArchiveMessage(msgs[0]!)).toBe(true);
    expect(msgs[1]!.role).toBe("user");
    const calls = msgs.flatMap((m) => (m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall").map((c) => (c as { id: string }).id) : []));
    const results = msgs.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : []));
    expect(results.sort()).toEqual(calls.sort());
  });

  it("compacting again extends the archive within its budget, keeping the newest history", async () => {
    const { conv, db } = await setup({ script: bigScript, context: { archiveTokens: 3000 } }); // 1 frame
    await fill(conv, 8);
    const first = (db.query("SELECT source_text FROM agent_archives").get() as { source_text: string }).source_text;
    await fill(conv, 16);
    const second = (db.query("SELECT through_seq, source_text FROM agent_archives").get() as { through_seq: number; source_text: string });
    expect(second.source_text).not.toBe(first);
    expect(second.source_text.length).toBeLessThan(first.length * 3); // bounded: old text falls off the front
    expect(second.source_text).toContain("第16轮");
  });

  it("says so and carries on when the recent window is one giant turn that cannot be cut", async () => {
    const huge: Script = () => [assistantText(tokensOf(9000))];
    const { conv, session, entries } = await setup({ script: huge });
    await conv.ask("一个问题");
    await conv.ask("另一个问题");
    expect(roles(session)).not.toContain("archive");
    expect(entries.some((e) => e.level === "warn" && e.msg.includes("not compacting"))).toBe(true);
  });
});
