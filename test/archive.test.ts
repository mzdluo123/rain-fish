import { describe, expect, it } from "bun:test";
import {
  buildArchiveMessage,
  canReadImages,
  ARCHIVE_MARKER,
  extendArchiveSource,
  isArchiveMessage,
  maxFramesFor,
  serializeForArchive,
  trimOldest,
} from "../src/context/archive.js";
import { frames } from "@oh-my-pi/snapcompact";
import { assistantCall, assistantText, toolResultMsg, userMsg } from "./helpers.js";

const vision: any = { api: "openai-responses", id: "gpt-5.5", provider: "openai", input: ["text", "image"] };
const textOnly: any = { ...vision, input: ["text"] };

describe("archive text", () => {
  it("serializes messages (without thinking) so they can be rendered", () => {
    const text = serializeForArchive([userMsg("晚上吃什么？"), assistantCall("1", "read", { path: "/a" }), toolResultMsg("1", "read", "内容"), assistantText("火锅")]);
    expect(text).toContain("晚上吃什么");
    expect(text).toContain("火锅");
  });

  it("trimOldest drops the start, never the end, and stops as soon as it fits", () => {
    const t = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const trimmed = trimOldest(t, (x) => x.length <= 200);
    expect(trimmed.length).toBeLessThanOrEqual(200);
    expect(trimmed.endsWith("line99")).toBe(true);
    expect(trimmed.startsWith("line")).toBe(true); // cut at a line boundary
    expect(trimOldest("short", () => true)).toBe("short");
    expect(trimOldest("never fits", () => false)).toBe(""); // terminates
  });

  it("extends the archive and keeps it within the frame budget, newest text surviving", () => {
    const b = { model: vision, archiveTokens: 3000 }; // 1 frame
    const old = "最早的消息 ".repeat(1500);
    const merged = extendArchiveSource(old, "最新的消息 END", b);
    expect(merged.endsWith("最新的消息 END")).toBe(true);
    expect(frames(merged, { model: vision })).toBeLessThanOrEqual(maxFramesFor(vision, 3000));
    expect(extendArchiveSource("", "first", b)).toBe("first");
  });

  it("budgets by tokens for models that cannot read images", () => {
    const merged = extendArchiveSource("字".repeat(5000), "尾巴", { model: textOnly, archiveTokens: 1000 });
    expect(merged.length).toBeLessThanOrEqual(1000);
    expect(merged.endsWith("尾巴")).toBe(true);
  });
});

describe("archive message", () => {
  it("is bitmap frames (PNG image blocks) for a vision model", async () => {
    const m = await buildArchiveMessage("小明: 晚上想吃火锅\nYukino: 好呀 ".repeat(50), { model: vision, archiveTokens: 20_000 });
    expect(isArchiveMessage(m)).toBe(true);
    expect(m.role === "user" && Array.isArray(m.content) && m.content[0]).toMatchObject({ type: "text" });
    const images = m.role === "user" && Array.isArray(m.content) ? m.content.filter((c) => c.type === "image") : [];
    expect(images.length).toBeGreaterThanOrEqual(1);
    expect(images[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(Buffer.from((images[0] as { data: string }).data, "base64").subarray(1, 4).toString()).toBe("PNG");
  });

  it("is plain text for a model without image input, and for an unknown model", async () => {
    for (const model of [textOnly, undefined]) {
      const m = await buildArchiveMessage("小明说要吃火锅", { model, archiveTokens: 1000 });
      expect(canReadImages(model)).toBe(false);
      const parts = m.role === "user" && Array.isArray(m.content) ? m.content : [];
      expect(parts.every((c) => c.type === "text")).toBe(true);
      expect(JSON.stringify(m)).toContain("小明说要吃火锅");
    }
  });

  it("is recognised by its marker only", () => {
    expect(isArchiveMessage(userMsg(`${ARCHIVE_MARKER} 归档`))).toBe(true);
    expect(isArchiveMessage(userMsg("普通消息"))).toBe(false);
    expect(isArchiveMessage(assistantText(`${ARCHIVE_MARKER} x`))).toBe(false);
  });
});
