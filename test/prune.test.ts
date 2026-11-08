import { describe, expect, it } from "bun:test";
import { buildArchiveMessage } from "../src/context/archive.js";
import { pruneExpensive } from "../src/context/prune.js";
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
});
