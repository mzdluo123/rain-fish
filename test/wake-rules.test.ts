import { describe, expect, it } from "bun:test";
import { openDb } from "../src/db/open.js";
import { VirtualFs } from "../src/vfs.js";
import { createVfsOperations } from "../src/vfs-ops.js";
import { createWakeRules, DEFAULT_RULES, MAX_RULES, parseWakeRules, renderWakeRules, WAKE_RULES_PATH, weighMessage } from "../src/wake-rules.js";
import { recordingLogger } from "./helpers.js";

const w = (text: string, addressed = false) => weighMessage(DEFAULT_RULES, text, addressed).weight;
const HEAD = "| 名称 | 权重 | 包含 | 开头 | 结尾 | 最长字数 | 特殊 |\n|---|---|---|---|---|---|---|\n";

describe("default keyword table", () => {
  it("ordinary text counts as 1", () => expect(w("今天吃什么")).toBe(1));
  it("questions, messages to the bot and help requests count less (answer sooner)", () => {
    expect(w("有人在吗？")).toBe(0.5);
    expect(w("what?")).toBe(0.5);
    expect(w("今天吃啥", true)).toBe(0.5);
    expect(w("bot 你怎么看")).toBeCloseTo(0.3, 9); // calls_bot x asks_help
    expect(w("为什么会这样")).toBe(0.6);
  });
  it("unfinished sentences count more (wait for the rest)", () => {
    expect(w("我觉得吧，")).toBe(2.5);
    expect(w("首先我们要")).toBe(2.5);
    expect(w("首先，")).toBe(2.5); // start and end both match: one row, counted once
    expect(w("等一下...")).toBe(2.5);
    expect(w("还有一点：", true)).toBe(1.25);
  });
  it("short closings and lone pictures count less, a long text that happens to contain 谢谢 does not", () => {
    expect(w("谢谢")).toBe(0.8);
    expect(w("[图片]")).toBe(0.3);
    expect(w("[图片][表情]")).toBe(0.3);
    expect(w("谢谢你昨天帮忙整理的那份资料，真的省了很多时间")).toBe(1);
    expect(w("看这个[图片]")).toBe(1);
  });
  it("arguments and 'be quiet' commands hold the bot back", () => {
    expect(w("你胡说")).toBe(1.5);
    expect(w("闭嘴")).toBe(3);
  });
  it("ignores case and clamps the product", () => {
    expect(w("BOT 在吗？")).toBeCloseTo(0.25, 9);
    expect(w("bot 帮我看看？", true)).toBe(0.2);
    expect(w("首先，你才不对，闭嘴")).toBeLessThanOrEqual(4);
  });
  it("reports which rows applied", () => {
    expect(weighMessage(DEFAULT_RULES, "bot 你怎么看？", true).rules).toEqual(["addressed", "question", "calls_bot", "asks_help"]);
    expect(weighMessage(DEFAULT_RULES, "今天吃什么", false).rules).toEqual([]);
  });
});

describe("the table file format", () => {
  it("rendering the default rules and parsing them gives the same rules", () => {
    expect(parseWakeRules(renderWakeRules(DEFAULT_RULES))).toEqual(DEFAULT_RULES as never);
  });

  it("the default file fits the agent's 10 KiB file limit", () => {
    expect(Buffer.byteLength(renderWakeRules(DEFAULT_RULES))).toBeLessThan(10 * 1024);
  });

  it("an empty table is valid (every message then weighs 1)", () => {
    expect(parseWakeRules(HEAD)).toEqual([]);
  });

  it("explains itself with free text around the table", () => {
    const rules = parseWakeRules(`# hi\nsome text\n\n${HEAD}| a | 2 | x y | | | 5 | |\n\nnotes after\n`);
    expect(rules).toEqual([{ name: "a", weight: 2, contains: ["x", "y"], starts: [], ends: [], maxLen: 5 }]);
  });

  const bad: [string, string, RegExp][] = [
    ["no table", "just text", /no table found/],
    ["wrong header", "| a | b |\n|---|---|\n", /line 1: the header row must be exactly/],
    ["missing separator", HEAD.split("\n")[0] + "\n| a | 1 | x | | | | |\n", /line 2: .*separator/],
    ["wrong column count", HEAD + "| a | 1 | x |\n", /line 3: expected 7 columns, found 3/],
    ["weight not a number", HEAD + "| a | heavy | x | | | | |\n", /line 3: 权重 "heavy"/],
    ["weight too big", HEAD + "| a | 9 | x | | | | |\n", /权重 "9" must be a number from/],
    ["weight too small", HEAD + "| a | 0 | x | | | | |\n", /权重/],
    ["duplicate name", HEAD + "| a | 1 | x | | | | |\n| a | 1 | y | | | | |\n", /line 4: .*used twice/],
    ["bad name", HEAD + "| a b | 1 | x | | | | |\n", /名称/],
    ["no condition", HEAD + "| a | 1 | | | | 5 | |\n", /has no condition/],
    ["bad special", HEAD + "| a | 1 | | | | | shout |\n", /特殊 "shout"/],
    ["bad max length", HEAD + "| a | 1 | x | | | 0 | |\n", /最长字数/],
    ["word too long", HEAD + `| a | 1 | ${"字".repeat(13)} | | | | |\n`, /longer than 12/],
    ["too many words", HEAD + `| a | 1 | ${Array.from({ length: 31 }, (_, i) => `w${i}`).join(" ")} | | | | |\n`, /at most 30 words/],
    ["two tables", `${HEAD}| a | 1 | x | | | | |\n\ntext\n\n${HEAD}`, /a second table/],
    ["too many rules", HEAD + Array.from({ length: MAX_RULES + 1 }, (_, i) => `| r${i} | 1 | x | | | | |\n`).join(""), new RegExp(`at most ${MAX_RULES} rules`)],
  ];
  for (const [name, text, re] of bad) it(`rejects: ${name}`, () => expect(() => parseWakeRules(text)).toThrow(re));
});

describe("/wake-rules.md in the agent's filesystem", () => {
  const setup = () => {
    const fs = new VirtualFs(openDb(":memory:"));
    const log = recordingLogger();
    return { fs, log, ops: createVfsOperations(fs), live: createWakeRules({ fs, logger: log.logger }) };
  };

  it("is created from the defaults when missing, and again if it disappears", () => {
    const { fs, live } = setup();
    expect(fs.exists(WAKE_RULES_PATH)).toBe(true);
    expect(fs.readText(WAKE_RULES_PATH)).toBe(renderWakeRules(DEFAULT_RULES));
    fs.remove(WAKE_RULES_PATH);
    expect(live.weigh("有人吗？", false).weight).toBe(0.5);
    expect(fs.exists(WAKE_RULES_PATH)).toBe(true);
  });

  it("keeps a file that already exists", () => {
    const fs = new VirtualFs(openDb(":memory:"));
    fs.writeFile(WAKE_RULES_PATH, `${HEAD}| mine | 4 | 哈哈 | | | | |\n`);
    const live = createWakeRules({ fs });
    expect(fs.readText(WAKE_RULES_PATH)).toContain("mine");
    expect(live.weigh("哈哈", false).weight).toBe(4);
    expect(live.weigh("有人吗？", false).weight).toBe(1); // the defaults are not mixed in
  });

  it("an edit by the agent takes effect on the next message (reload)", async () => {
    const { ops, live, log } = setup();
    expect(live.weigh("哈哈哈哈", false).weight).toBe(0.8);
    const text = (await ops.edit.readFile(WAKE_RULES_PATH)).toString();
    await ops.edit.writeFile(WAKE_RULES_PATH, text.replace("| closing | 0.8 |", "| closing | 0.4 |"));
    expect(live.weigh("哈哈哈哈", false).weight).toBe(0.4);
    expect(log.entries.some((e) => e.level === "info" && /reloaded \d+ wake rule/.test(e.msg))).toBe(true);
  });

  it("an edit that breaks the table fails and leaves the file as it was", async () => {
    const { fs, ops, live } = setup();
    const before = fs.readText(WAKE_RULES_PATH);
    await expect(ops.edit.writeFile(WAKE_RULES_PATH, before.replace("| closing | 0.8 |", "| closing | lots |"))).rejects.toThrow(/was not changed.*line \d+: 权重 "lots"/);
    await expect(ops.write.writeFile(WAKE_RULES_PATH, "I deleted the table")).rejects.toThrow(/no table found/);
    expect(fs.readText(WAKE_RULES_PATH)).toBe(before);
    expect(live.weigh("哈哈哈哈", false).weight).toBe(0.8);
  });

  it("other files are not validated as rules", async () => {
    const { ops } = setup();
    await ops.write.writeFile("/notes/rules.md", "| not | a | table");
  });

  it("a file broken from outside (host tool) keeps the last good table in force and warns once", () => {
    const { fs, live, log } = setup();
    expect(live.weigh("哈哈哈哈", false).weight).toBe(0.8);
    fs.writeFile(WAKE_RULES_PATH, "garbage");
    expect(live.weigh("哈哈哈哈", false).weight).toBe(0.8);
    live.weigh("哈哈哈哈", false);
    expect(log.entries.filter((e) => e.level === "warn" && /invalid, keeping the previous rules/.test(e.msg))).toHaveLength(1);
    fs.writeFile(WAKE_RULES_PATH, `${HEAD}| x | 3 | 哈哈 | | | | |\n`); // fixed later: picked up again
    expect(live.weigh("哈哈哈哈", false).weight).toBe(3);
  });
});
