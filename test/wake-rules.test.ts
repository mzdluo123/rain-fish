import { describe, expect, it } from "bun:test";
import { openDb } from "../src/db/open.js";
import { VirtualFs } from "../src/vfs.js";
import { createVfsOperations } from "../src/vfs-ops.js";
import { createWakeRules, DEFAULT_RULES, LEGACY_WAKE_RULES_PATH, MAX_RULES, parseWakeRules, parseWakeRulesFile, renderWakeRules, WAKE_RULES_PATH, weighMessage } from "../src/wake-rules.js";
import { recordingLogger } from "./helpers.js";

const w = (text: string, addressed = false) => weighMessage(DEFAULT_RULES, text, addressed).weight;

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

describe("the YAML file format", () => {
  it("rendering the default rules and parsing them gives the same rules", () => {
    expect(parseWakeRules(renderWakeRules(DEFAULT_RULES))).toEqual(DEFAULT_RULES as never);
  });

  it("the default file fits the agent's 10 KiB file limit", () => {
    expect(Buffer.byteLength(renderWakeRules(DEFAULT_RULES))).toBeLessThan(10 * 1024);
  });

  it("an empty list is valid (every message then weighs 1)", () => {
    expect(parseWakeRules("rules: []")).toEqual([]);
  });

  it("reads plain YAML: block lists, comments, lowercased words, optional fields, optional timing", () => {
    const parsed = parseWakeRulesFile(`# mine
timing:
  chat_mean_seconds: 30
  addressed_mean_seconds: 2
  decay_per_second: 0.5
  quiet_threshold: 0.25
rules:
  - name: a   # inline comment
    weight: 2
    contains:
      - X
      - y z
    max_len: 5
  - name: b
    weight: 0.5
    special: addressed
`);
    expect(parsed).toEqual({
      timing: { chatMeanSeconds: 30, addressedMeanSeconds: 2, decayPerSec: 0.5, quietThreshold: 0.25 },
      rules: [
        { name: "a", weight: 2, contains: ["x", "y z"], starts: [], ends: [], maxLen: 5 },
        { name: "b", weight: 0.5, contains: [], starts: [], ends: [], special: "addressed" },
      ],
    });
    expect(parseWakeRulesFile(renderWakeRules(DEFAULT_RULES, parsed.timing))).toEqual({
      timing: parsed.timing,
      rules: DEFAULT_RULES as never,
    });
  });

  const r = (body: string) => `rules:\n  - name: a\n    weight: 1\n${body}`;
  const bad: [string, string, RegExp][] = [
    ["not YAML", "rules: [", /not valid YAML/],
    ["empty file", "", /rules/],
    ["not a mapping", "- name: a", /rules/],
    ["no rules key", "other: 1", /rules/],
    ["unknown top-level key", "rules: []\nextra: 1", /extra|Unrecognized/],
    ["unknown timing key", "timing:\n  max_wait_seconds: 999\nrules: []", /timing.*max_wait_seconds|Unrecognized/],
    ["chat_mean_seconds too small", "timing:\n  chat_mean_seconds: 5\nrules: []", /timing\.chat_mean_seconds: must be at least 10/],
    ["chat_mean_seconds too big", "timing:\n  chat_mean_seconds: 300\nrules: []", /timing\.chat_mean_seconds: must be at most 120/],
    ["addressed_mean_seconds negative", "timing:\n  addressed_mean_seconds: -1\nrules: []", /timing\.addressed_mean_seconds: must be at least 0/],
    ["addressed_mean_seconds too big", "timing:\n  addressed_mean_seconds: 25\nrules: []", /timing\.addressed_mean_seconds: must be at most 10/],
    ["decay_per_second too small", "timing:\n  decay_per_second: 0.05\nrules: []", /timing\.decay_per_second: must be at least 0.15/],
    ["decay_per_second too big", "timing:\n  decay_per_second: 2\nrules: []", /timing\.decay_per_second: must be at most 1/],
    ["quiet_threshold too small", "timing:\n  quiet_threshold: 0.01\nrules: []", /timing\.quiet_threshold: must be at least 0.1/],
    ["quiet_threshold too big", "timing:\n  quiet_threshold: 0.95\nrules: []", /timing\.quiet_threshold: must be at most 0.8/],
    ["unknown field in a rule", r("    contains: [x]\n    colour: red\n"), /rules\[1\].*colour|Unrecognized/],
    ["weight not a number", r("    contains: [x]\n").replace("weight: 1", "weight: heavy"), /rules\[1\]\.weight/],
    ["weight too big", r("    contains: [x]\n").replace("weight: 1", "weight: 9"), /weight: must be at most 5/],
    ["weight too small", r("    contains: [x]\n").replace("weight: 1", "weight: 0"), /weight: must be at least 0.1/],
    ["duplicate name", `${r("    contains: [x]\n")}  - name: a\n    weight: 1\n    contains: [y]\n`, /"a" is used twice/],
    ["bad name", r("    contains: [x]\n").replace("name: a", "name: a b"), /rules\[1\]\.name/],
    ["numeric name", r("    contains: [x]\n").replace("name: a", "name: 123"), /rules\[1\]\.name/],
    ["no condition", r("    max_len: 5\n"), /has no condition/],
    ["bad special", r("    special: shout\n"), /special: must be addressed or placeholder/],
    ["bad max length", r("    contains: [x]\n    max_len: 0\n"), /max_len/],
    ["fractional max length", r("    contains: [x]\n    max_len: 2.5\n"), /max_len/],
    ["word too long", r(`    contains: ["${"字".repeat(13)}"]\n`), /1-12 characters/],
    ["word that is not a string", r("    contains: [~]\n"), /contains/],
    ["too many words", r(`    contains: [${Array.from({ length: 31 }, (_, i) => `w${i}`).join(", ")}]\n`), /at most 30 words/],
    ["too many rules", `rules:\n${Array.from({ length: MAX_RULES + 1 }, (_, i) => `  - {name: r${i}, weight: 1, contains: [x]}\n`).join("")}`, new RegExp(`at most ${MAX_RULES} rules`)],
    ["alias bomb", "rules: []\n" + ["a: &a [x,x,x,x,x,x,x,x,x]", ...Array.from("bcdefghi", (k, i) => `${k}: &${k} [${Array(9).fill(`*${"abcdefgh"[i]}`).join(",")}]`)].join("\n"), /./],
  ];
  for (const [name, text, re] of bad) it(`rejects: ${name}`, () => expect(() => parseWakeRules(text)).toThrow(re));
});

describe("/wake-rules.yaml in the agent's filesystem", () => {
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
    fs.writeFile(WAKE_RULES_PATH, "rules:\n  - {name: mine, weight: 4, contains: [哈哈]}\n");
    const live = createWakeRules({ fs });
    expect(fs.readText(WAKE_RULES_PATH)).toContain("mine");
    expect(live.weigh("哈哈", false).weight).toBe(4);
    expect(live.weigh("有人吗？", false).weight).toBe(1); // the defaults are not mixed in
  });

  it("replaces the old Markdown table: the YAML file is seeded and the .md file is removed, with a warning", () => {
    const fs = new VirtualFs(openDb(":memory:"));
    fs.writeFile(LEGACY_WAKE_RULES_PATH, "| 名称 | ... |");
    const log = recordingLogger();
    createWakeRules({ fs, logger: log.logger });
    expect(fs.exists(WAKE_RULES_PATH)).toBe(true);
    expect(fs.exists(LEGACY_WAKE_RULES_PATH)).toBe(false);
    expect(log.entries.some((e) => e.level === "warn" && e.msg.includes(LEGACY_WAKE_RULES_PATH))).toBe(true);
  });

  it("migrating from the legacy table rewrites the /persona.md link to the YAML file", () => {
    const fs = new VirtualFs(openDb(":memory:"));
    fs.writeFile(LEGACY_WAKE_RULES_PATH, "| 名称 | ... |");
    fs.writeFile("/persona.md", "- [唤醒规则](/wake-rules.md)：调整唤醒权重\n");
    createWakeRules({ fs });
    expect(fs.exists(LEGACY_WAKE_RULES_PATH)).toBe(false);
    expect(fs.readText("/persona.md")).toBe("- [唤醒规则](/wake-rules.yaml)：调整唤醒权重\n");
  });

  it("an edit by the agent takes effect on the next message (reload, including timing)", async () => {
    const { ops, live, log } = setup();
    expect(live.weigh("哈哈哈哈", false).weight).toBe(0.8);
    expect(live.timing()).toBeUndefined();
    const text = (await ops.edit.readFile(WAKE_RULES_PATH)).toString();
    await ops.edit.writeFile(WAKE_RULES_PATH, `timing:\n  chat_mean_seconds: 20\n${text.replace("weight: 0.8", "weight: 0.4")}`);
    expect(live.weigh("哈哈哈哈", false).weight).toBe(0.4);
    expect(live.timing()).toEqual({ chatMeanSeconds: 20 });
    expect(log.entries.some((e) => e.level === "info" && /reloaded \d+ wake rule/.test(e.msg))).toBe(true);
  });

  it("an edit that breaks the file fails and leaves it as it was", async () => {
    const { fs, ops, live } = setup();
    const before = fs.readText(WAKE_RULES_PATH);
    await expect(ops.edit.writeFile(WAKE_RULES_PATH, before.replace("weight: 0.8", "weight: lots"))).rejects.toThrow(/was not changed.*weight/);
    await expect(ops.edit.writeFile(WAKE_RULES_PATH, `timing:\n  chat_mean_seconds: 1\n${before}`)).rejects.toThrow(/was not changed.*timing\.chat_mean_seconds/);
    await expect(ops.write.writeFile(WAKE_RULES_PATH, "I deleted everything")).rejects.toThrow(/was not changed/);
    expect(fs.readText(WAKE_RULES_PATH)).toBe(before);
    expect(live.weigh("哈哈哈哈", false).weight).toBe(0.8);
  });

  it("is the only non-Markdown, non-Python file the agent may write; the size limit applies", async () => {
    const { ops } = setup();
    await expect(ops.write.writeFile("/other.yaml", "rules: []")).rejects.toThrow(/only Markdown/);
    await expect(ops.write.writeFile("/wake-rules.yml", "rules: []")).rejects.toThrow(/only Markdown/);
    await expect(ops.write.writeFile(WAKE_RULES_PATH, "rules: []\n#" + "x".repeat(11_000))).rejects.toThrow(/EFBIG.*Remove or merge rules/);
  });

  it("other files are not validated as rules", async () => {
    const { ops } = setup();
    await ops.write.writeFile("/notes/rules.md", "rules: [");
  });

  it("a file broken from outside (host tool) keeps the last good rules in force and warns once", () => {
    const { fs, live, log } = setup();
    expect(live.weigh("哈哈哈哈", false).weight).toBe(0.8);
    fs.writeFile(WAKE_RULES_PATH, "garbage: [");
    expect(live.weigh("哈哈哈哈", false).weight).toBe(0.8);
    live.weigh("哈哈哈哈", false);
    expect(log.entries.filter((e) => e.level === "warn" && /invalid, keeping the previous rules/.test(e.msg))).toHaveLength(1);
    fs.writeFile(WAKE_RULES_PATH, "rules:\n  - {name: x, weight: 3, contains: [哈哈]}\n"); // fixed later: picked up again
    expect(live.weigh("哈哈哈哈", false).weight).toBe(3);
  });
});
