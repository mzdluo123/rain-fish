import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildArchiveMessage } from "../src/context/archive.js";
import { pruneExpensive, type PruneState } from "../src/context/prune.js";
import { assistantCall, assistantText, tokensOf, toolResultMsg, userMsg } from "./helpers.js";

const opts = { recentTokens: 300, minBlockTokens: 500 };
const text = (m: unknown) => JSON.stringify(m);

describe("pruneExpensive (level 1)", () => {
  it("clears big tool results and big tool-call arguments once they fall out of the recent window", () => {
    const old = [
      userMsg("读一下文件"),
      assistantCall("c1", "write", { path: "/a.md", content: tokensOf(2000) }),
      toolResultMsg("c1", "read", tokensOf(3000)),
      assistantText("好了"),
    ];
    const recent = [userMsg(tokensOf(100)), assistantText(tokensOf(100))];
    const out = pruneExpensive([...old, ...recent], opts);

    expect(out).toHaveLength(6);
    expect(text(out[2])).toContain("已清理：read 的输出");
    expect(text(out[2])).not.toContain("字字字");
    expect(text(out[1])).toContain("已清理：2000 字符");
    expect(text(out[1])).toContain('"path":"/a.md"'); // small arguments stay
    expect(out[3]).toBe(old[3]!); // small blocks and plain text are untouched (same object)
    expect(out[4]).toBe(recent[0]!);
  });

  it("keeps message order, roles, tool-call ids and the call/result pairing", () => {
    const msgs = [
      userMsg("q"),
      assistantCall("call-9", "read", { path: "/x" }),
      toolResultMsg("call-9", "read", tokensOf(4000)),
      userMsg(tokensOf(400)),
    ];
    const out = pruneExpensive(msgs, opts);
    expect(out.map((m) => m.role)).toEqual(msgs.map((m) => m.role));
    const result = out[2]!;
    expect(result.role === "toolResult" && result.toolCallId).toBe("call-9");
    expect(result.role === "toolResult" && result.toolName).toBe("read");
  });

  it("never touches the recent window, even for huge blocks", () => {
    const msgs = [userMsg("q"), assistantCall("1", "read", {}), toolResultMsg("1", "read", tokensOf(5000)), assistantText("ok")];
    // the whole tail (5000 + ...) exceeds recentTokens, but the newest messages are inside the window
    const out = pruneExpensive(msgs, { recentTokens: 6000, minBlockTokens: 500 });
    expect(out[2]).toBe(msgs[2]!);
  });

  it("only clears blocks at or above the minimum size", () => {
    const mk = (n: number) => [userMsg("q"), toolResultMsg("1", "grep", tokensOf(n)), userMsg(tokensOf(400))];
    expect(text(pruneExpensive(mk(499), opts)[1])).not.toContain("已清理");
    expect(text(pruneExpensive(mk(500), opts)[1])).toContain("已清理");
  });

  it("is pure and idempotent: input untouched, a second pass changes nothing", () => {
    const msgs = [userMsg("q"), toolResultMsg("1", "read", tokensOf(2000)), userMsg(tokensOf(400))];
    const snapshot = text(msgs);
    const once = pruneExpensive(msgs, opts);
    expect(text(msgs)).toBe(snapshot);
    expect(text(pruneExpensive(once, opts))).toBe(text(once));
  });

  it("leaves the archive message alone", async () => {
    const archive = await buildArchiveMessage(tokensOf(3000), { model: undefined, archiveTokens: 100_000 });
    const out = pruneExpensive([archive, userMsg(tokensOf(600))], { recentTokens: 100, minBlockTokens: 10 });
    expect(out[0]).toBe(archive);
  });

  it("clears pictures of old user messages (text kept), leaves recent ones and the archive frames alone", async () => {
    const png = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
    const pic = (t: string): AgentMessage => ({ role: "user", content: [{ type: "text", text: t }, png], timestamp: 1 });
    const archive = await buildArchiveMessage("¶user: x", { model: undefined, archiveTokens: 1000 });
    const old = pic("旧图");
    const recent = pic("新图");
    const out = pruneExpensive([archive, old, assistantText(tokensOf(400)), recent], opts);
    expect(out[0]).toBe(archive);
    expect(text(out[1])).toContain("旧图");
    expect(text(out[1])).toContain("已清理：图片");
    expect(text(out[1])).not.toContain("AAAA");
    expect(out[3]).toBe(recent);
  });

  it("shows a picture sent several times once, at its newest copy; the stored history is untouched", () => {
    const pic = (t: string, data: string): AgentMessage => ({ role: "user", content: [{ type: "text", text: t }, { type: "image", data, mimeType: "image/png" }], timestamp: 1 });
    const first = pic("第一次", "AAAA");
    const other = pic("别的图", "BBBB");
    const again = pic("又来了", "AAAA");
    const out = pruneExpensive([first, assistantText("ok"), other, assistantText("ok"), again], { recentTokens: 100_000, minBlockTokens: 500 });
    expect(text(out[0])).toContain("重复图片");
    expect(text(out[0])).toContain("第一次");
    expect(text(out[0])).not.toContain("AAAA");
    expect(out[2]).toBe(other);
    expect(out[4]).toBe(again);
    expect(text(first)).toContain("AAAA");
  });
});

describe("pruneExpensive batching (keeps the prompt-cache prefix stable)", () => {
  const o = { recentTokens: 300, minBlockTokens: 500, batchBlocks: 3 };
  const bigTurn = (i: number) => [userMsg(`q${i}`), assistantCall(`c${i}`, "read", {}), toolResultMsg(`c${i}`, "read", tokensOf(1000))];
  const filler = () => [userMsg(tokensOf(400)), assistantText(tokensOf(400))]; // pushes everything before it out of the recent window
  const cleared = (out: unknown[]) => out.filter((m) => text(m).includes("已清理")).length;

  it("clears nothing until `batchBlocks` big blocks are outside the window, then clears them all at once", () => {
    const state: PruneState = { through: 0 };
    let msgs = [...bigTurn(1), ...bigTurn(2), ...filler()];
    expect(cleared(pruneExpensive(msgs, o, state))).toBe(0); // 2 eligible < 3
    msgs = [...msgs, ...bigTurn(3), ...filler()];
    expect(cleared(pruneExpensive(msgs, o, state))).toBe(3); // 3 eligible: the whole batch goes
  });

  it("a cleared block stays cleared and later big blocks do not change the earlier part of the view until the next batch", () => {
    const state: PruneState = { through: 0 };
    let msgs = [...bigTurn(1), ...bigTurn(2), ...bigTurn(3), ...filler()];
    const first = pruneExpensive(msgs, o, state).map(text);
    msgs = [...msgs, ...bigTurn(4), ...filler()];
    const second = pruneExpensive(msgs, o, state).map(text);
    expect(second.slice(0, first.length)).toEqual(first); // append-only: same prefix
    expect(cleared(pruneExpensive(msgs, o, state))).toBe(3); // block 4 is eligible but alone (1 < 3)
  });

  it("estimates (commit=false) do not move the watermark", () => {
    const state: PruneState = { through: 0 };
    const msgs = [...bigTurn(1), ...bigTurn(2), ...bigTurn(3), ...filler()];
    expect(cleared(pruneExpensive(msgs, o, state, false))).toBe(3);
    expect(state.through).toBe(0);
    pruneExpensive(msgs, o, state);
    expect(state.through).toBeGreaterThan(0);
  });
});

describe("pruneExpensive: view_image results", () => {
  const viewed = (id: string): AgentMessage => ({
    role: "toolResult", toolCallId: id, toolName: "view_image", isError: false, timestamp: 1,
    content: [{ type: "text", text: "Picture i1:" }, { type: "image", data: "AAAA", mimeType: "image/png" }],
  });

  it("clears the picture of an earlier turn but keeps the one of the turn in progress", () => {
    const older = [userMsg("看图"), assistantCall("c1", "view_image", { image_id: "i1" }), viewed("c1"), assistantText("嗯"), userMsg(tokensOf(100)), assistantText(tokensOf(100))];
    const out = pruneExpensive(older, { recentTokens: 150, minBlockTokens: 100_000 });
    expect(text(out[2])).toContain("已清理：图片");
    expect(text(out[2])).toContain("Picture i1:");

    const live = [userMsg("看图"), assistantCall("c1", "view_image", { image_id: "i1" }), viewed("c1")];
    expect(text(pruneExpensive(live, { recentTokens: 1, minBlockTokens: 100_000 })[2])).toContain('"type":"image"');
  });
});
