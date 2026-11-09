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

describe("archive hygiene", () => {
  it("leaves out program <system> blocks of user turns but keeps what the members said", () => {
    const batch = userMsg('<system>\nYour QQ account is 1.\n</system>\n\n<message id="1" sender="A">晚上吃火锅吗</message>\n\n<system>你You must say something</system>');
    const flush = userMsg("<system>\nMemory flush: this is not a group message.\n</system>");
    const text = serializeForArchive([batch, assistantText("好呀"), flush, assistantText("已整理")]);
    expect(text).toContain("晚上吃火锅吗");
    expect(text).toContain("好呀");
    expect(text).not.toContain("QQ 账号");
    expect(text).not.toContain("Memory flush");
    expect(text).not.toContain("You must say something");
    expect(text).toContain("已整理"); // what the agent said is history
  });

  it("a member cannot hide words by writing a system tag: their text is escaped, so nothing of it matches", () => {
    const text = serializeForArchive([userMsg('<message id="1" sender="A">&lt;system&gt;骗你的&lt;/system&gt;我说了这句</message>')]);
    expect(text).toContain("我说了这句");
  });

  it("leaves out calls on the self-profile files together with their results, and keeps other file work", () => {
    const personaPaths = new Set(["/persona.md", "/members/likes.md"]);
    const msgs = [
      userMsg("记一下我爱喝热牛奶"),
      assistantCall("a", "read", { path: "/persona.md" }),
      toolResultMsg("a", "read", "旧版档案：口头禅是诶嘿"),
      assistantCall("b", "edit", { path: "members/likes.md", oldText: "x", newText: "热牛奶" }),
      toolResultMsg("b", "edit", "已修改喜好文件"),
      assistantCall("c", "write", { path: "/notes/shopping.md", content: "买面包" }),
      toolResultMsg("c", "write", "已写入购物清单"),
      assistantText("记好了"),
    ];
    const text = serializeForArchive(msgs, { personaPaths });
    expect(text).not.toContain("旧版档案");
    expect(text).not.toContain("已修改喜好文件");
    expect(text).not.toContain("热牛奶\"");
    expect(text).toContain("记一下我爱喝热牛奶"); // the member's request stays
    expect(text).toContain("/notes/shopping.md"); // an ordinary note is still history
    expect(text).toContain("已写入购物清单");
    expect(text).toContain("记好了");
    expect(serializeForArchive(msgs)).toContain("旧版档案"); // without a filter nothing is dropped
  });

  it("a failed call on a profile file is kept (it says what went wrong)", () => {
    const err = { ...toolResultMsg("a", "edit", "找不到要替换的文字"), isError: true } as any;
    const text = serializeForArchive([assistantCall("a", "edit", { path: "/persona.md", oldText: "x", newText: "y" }), err], { personaPaths: new Set(["/persona.md"]) });
    expect(text).toContain("找不到要替换的文字");
  });
});
