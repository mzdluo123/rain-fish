import { describe, expect, it } from "bun:test";
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens, IMAGE_TOKENS } from "../src/context/estimate.js";
import { assistantCall, assistantText, toolResultMsg, userMsg } from "./helpers.js";

describe("token estimate", () => {
  it("counts CJK ~1 token per character and Latin ~4 characters per token", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("你好世界")).toBe(4);
    expect(estimateTextTokens("abcdefgh")).toBe(2);
    expect(estimateTextTokens("你好 abcd")).toBe(2 + Math.ceil(5 / 4));
    expect(estimateTextTokens("日本語のテスト")).toBe(7); // kana + kanji
  });

  it("estimates every message role, including tool calls and images", () => {
    expect(estimateMessageTokens(userMsg("字".repeat(10)))).toBe(10);
    expect(estimateMessageTokens(assistantText("字".repeat(10)))).toBeGreaterThanOrEqual(10);
    expect(estimateMessageTokens(toolResultMsg("1", "read", "字".repeat(50)))).toBe(50);
    expect(estimateMessageTokens(assistantCall("1", "write", { content: "字".repeat(100) }))).toBeGreaterThan(100);
    expect(
      estimateMessageTokens({ role: "user", content: [{ type: "text", text: "字字" }, { type: "image", data: "x", mimeType: "image/png" }], timestamp: 1 }),
    ).toBe(2 + IMAGE_TOKENS);
  });

  it("a context estimate includes the system prompt and tool overhead", () => {
    expect(estimateContextTokens("字".repeat(100), [])).toBeGreaterThan(100);
    expect(estimateContextTokens("", [userMsg("字".repeat(10))])).toBe(estimateContextTokens("", []) + 10);
  });
});
