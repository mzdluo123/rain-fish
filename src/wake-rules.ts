/**
 * The keyword/heat table of the wake-up scheduler, kept in the agent's own virtual filesystem as `/wake-rules.md` so the
 * agent can tune how quickly it reacts. The file is a Markdown table (the agent may only write `.md`):
 *
 *   - If it does not exist it is created from `DEFAULT_RULES` (`createWakeRules`, also if it disappears later).
 *   - Every message re-reads it; a changed text is parsed and takes effect at once (reload), whoever wrote it.
 *   - The agent's write/edit of this path is validated first (`assertAgentWritable` -> `parseWakeRules`): a table that does
 *     not parse is refused with the reason and nothing is written, so the file on disk is always valid. If it was broken
 *     from outside anyway (host `bun run fs`), the last good table stays in force and a warning is logged.
 *
 * It is agent-writable, so group members can influence it. What it can do is bounded: plain substring tests only (no
 * regex), at most `MAX_RULES` rows, weights in [`MIN_RULE_WEIGHT`, `MAX_RULE_WEIGHT`], a product clamped to [`MIN_WEIGHT`, `MAX_WEIGHT`],
 * and the wake-up always stays under `WAKE_MAX_WAIT_SECONDS` / `WAKE_ADDRESSED_MAX_WAIT_SECONDS` / `WAKE_MAX_BATCH`.
 */
import type { Logger, WeighFn, WeightRule, WeightRuleSpecial } from "./types.js";
import { noopLogger } from "./logger.js";
import type { VirtualFs } from "./vfs.js";

export const WAKE_RULES_PATH = "/wake-rules.md";
export const MAX_RULES = 40;
export const MAX_WORDS_PER_CELL = 30;
export const MAX_WORD_CHARS = 12;
export const MIN_RULE_WEIGHT = 0.1;
export const MAX_RULE_WEIGHT = 5;
/** Final clamp of a message's weight (the product of all rows that apply). */
export const MIN_WEIGHT = 0.2;
export const MAX_WEIGHT = 4;

export const COLUMNS = ["名称", "权重", "包含", "开头", "结尾", "最长字数", "特殊"] as const;

export const DEFAULT_RULES: readonly WeightRule[] = [
  // waiting for an answer: come sooner
  { name: "addressed", weight: 0.5, contains: [], starts: [], ends: [], special: "addressed" },
  { name: "question", weight: 0.5, contains: [], starts: [], ends: ["?", "？"] },
  { name: "calls_bot", weight: 0.5, contains: ["bot", "机器人"], starts: [], ends: [] },
  { name: "asks_help", weight: 0.6, contains: ["帮我", "怎么", "为什么", "能不能"], starts: [], ends: [] },
  // the conversation is closing or empty: no reason to wait
  { name: "closing", weight: 0.8, contains: ["好的", "谢谢", "晚安", "哈哈"], starts: [], ends: [], maxLen: 8 },
  { name: "placeholder_only", weight: 0.3, contains: [], starts: [], ends: [], special: "placeholder" },
  // more is coming: wait
  { name: "unfinished", weight: 2.5, contains: [], starts: ["首先", "第一", "其一", "先说"], ends: ["，", "、", "：", ",", ":", "…", "..."] },
  { name: "heated", weight: 1.5, contains: ["不对", "胡说", "你才"], starts: [], ends: [] },
  { name: "keep_quiet", weight: 3, contains: ["别说话", "闭嘴"], starts: [], ends: [] },
];

const INTRO = `# 唤醒热度规则

这张表决定群里每条消息让你"多快被叫醒"。你被唤醒的时机取决于群里的"热度"：每条消息都会加热，热度会随时间冷却，等冷到阈值以下你才被叫醒。表里每一行是一类消息，\`权重\` 就是这类消息的加热倍数：

- **小于 1**：更快叫醒你（有人在等你回答，或话题已经结束）。
- **大于 1**：多等一会儿再叫醒你（话还没说完，或正在争吵，别急着插嘴）。
- 一条消息命中几行，权重就相乘，最后限制在 ${MIN_WEIGHT} 到 ${MAX_WEIGHT} 之间。没命中任何一行的消息权重是 1。

## 怎么改
用 \`edit\` 改动或增删表里的行，一次改一处最稳妥。表格格式不对时（列数不对、权重不是 ${MIN_RULE_WEIGHT}~${MAX_RULE_WEIGHT} 之间的数字、名称重复、一行里没有任何条件……）修改会失败，原文件保持不变，错误信息会告诉你是哪一行。最多 ${MAX_RULES} 行。

## 每列的意思
- \`名称\`：随便取，不能重复，只能用字母、数字、下划线、连字符或汉字。
- \`权重\`：${MIN_RULE_WEIGHT}~${MAX_RULE_WEIGHT}。
- \`包含\` / \`开头\` / \`结尾\`：词用空格隔开（词里不能有空格，每个最多 ${MAX_WORD_CHARS} 个字符，不分大小写）；消息含有其中任何一个，就算命中。三列都空时留空即可。
- \`最长字数\`：可选。填了的话，消息超过这么多字就不算命中（用来限制"收尾"这类短句）。
- \`特殊\`：可选。\`addressed\` = 有人 @ 你或回复你；\`placeholder\` = 整条消息只有 \`[图片]\` \`[表情]\` 这样的占位。
- 同一行里，条件之间是"或"：任何一个满足就命中（再受最长字数限制）。至少要有一个条件。

`;

/** The file's text for a set of rules (what is seeded; `parseWakeRules(renderWakeRules(r))` gives `r` back). */
export function renderWakeRules(rules: readonly WeightRule[]): string {
  const cell = (xs: readonly string[]) => xs.join(" ");
  const rows = rules.map((r) => `| ${r.name} | ${r.weight} | ${cell(r.contains)} | ${cell(r.starts)} | ${cell(r.ends)} | ${r.maxLen ?? ""} | ${r.special ?? ""} |`);
  return `${INTRO}| ${COLUMNS.join(" | ")} |\n|${COLUMNS.map(() => "---").join("|")}|\n${rows.join("\n")}\n`;
}

export class WakeRulesError extends Error {}

/** Parses the table of the file. Throws `WakeRulesError` naming the line when anything is off; text outside the table is ignored. */
export function parseWakeRules(text: string): WeightRule[] {
  const lines = text.split(/\r?\n/);
  const rules: WeightRule[] = [];
  const names = new Set<string>();
  let state: "before" | "separator" | "rows" = "before";
  let sawTable = false;
  const fail = (n: number, msg: string): never => {
    throw new WakeRulesError(`line ${n}: ${msg}`);
  };
  const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const words = (n: number, col: string, cell: string) => {
    const ws = cell.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
    if (ws.length > MAX_WORDS_PER_CELL) fail(n, `column ${col}: at most ${MAX_WORDS_PER_CELL} words`);
    for (const w of ws) if ([...w].length > MAX_WORD_CHARS) fail(n, `column ${col}: the word "${w}" is longer than ${MAX_WORD_CHARS} characters`);
    return ws;
  };
  lines.forEach((raw, i) => {
    const n = i + 1;
    if (!raw.trim().startsWith("|")) {
      if (state === "rows" && raw.trim()) state = "before"; // the table ended; a second table would be rejected below
      return;
    }
    if (state === "before") {
      if (sawTable) fail(n, "a second table; keep all rules in one table");
      sawTable = true;
      const head = cells(raw);
      if (head.length !== COLUMNS.length || head.some((h, k) => h !== COLUMNS[k])) fail(n, `the header row must be exactly: | ${COLUMNS.join(" | ")} |`);
      state = "separator";
      return;
    }
    if (state === "separator") {
      if (!/^\|[\s:|-]+\|?$/.test(raw.trim())) fail(n, "the line under the header must be the separator row: |---|---|...|");
      state = "rows";
      return;
    }
    const c = cells(raw);
    if (c.length !== COLUMNS.length) fail(n, `expected ${COLUMNS.length} columns, found ${c.length} (a "|" inside a cell?)`);
    const [name = "", weightCell = "", contains = "", starts = "", ends = "", maxCell = "", specialCell = ""] = c;
    if (!/^[A-Za-z0-9_\-一-鿿]{1,24}$/.test(name)) fail(n, `名称 "${name}" must be 1-24 letters, digits, "_", "-" or Chinese characters`);
    if (names.has(name)) fail(n, `名称 "${name}" is used twice`);
    const weight = Number(weightCell);
    if (!weightCell || !Number.isFinite(weight) || weight < MIN_RULE_WEIGHT || weight > MAX_RULE_WEIGHT) fail(n, `权重 "${weightCell}" must be a number from ${MIN_RULE_WEIGHT} to ${MAX_RULE_WEIGHT}`);
    let maxLen: number | undefined;
    if (maxCell) {
      maxLen = Number(maxCell);
      if (!Number.isInteger(maxLen) || maxLen < 1 || maxLen > 500) fail(n, `最长字数 "${maxCell}" must be a whole number from 1 to 500, or empty`);
    }
    if (specialCell && specialCell !== "addressed" && specialCell !== "placeholder") fail(n, `特殊 "${specialCell}" must be empty, addressed or placeholder`);
    const rule: WeightRule = { name, weight, contains: words(n, "包含", contains), starts: words(n, "开头", starts), ends: words(n, "结尾", ends) };
    if (maxLen !== undefined) rule.maxLen = maxLen;
    if (specialCell) rule.special = specialCell as WeightRuleSpecial;
    if (!rule.contains.length && !rule.starts.length && !rule.ends.length && !rule.special) fail(n, `row "${name}" has no condition (fill 包含, 开头, 结尾 or 特殊)`);
    if (rules.length >= MAX_RULES) fail(n, `at most ${MAX_RULES} rules`);
    names.add(name);
    rules.push(rule);
  });
  if (!sawTable) throw new WakeRulesError("no table found: keep the table with the header | " + COLUMNS.join(" | ") + " |");
  return rules;
}

/** The text is only a placeholder like "[图片]" / "[表情]": nothing a member wrote. */
const placeholderOnly = /^(\[[^\]]{1,6}\])+$/;

function applies(r: WeightRule, t: string, addressed: boolean): boolean {
  if (r.maxLen !== undefined && [...t].length > r.maxLen) return false;
  return (
    (r.special === "addressed" && addressed) ||
    (r.special === "placeholder" && placeholderOnly.test(t)) ||
    r.contains.some((w) => t.includes(w)) ||
    r.starts.some((w) => t.startsWith(w)) ||
    r.ends.some((w) => t.endsWith(w))
  );
}

/** How strongly one message excites the chat relative to an ordinary one (1): the product of the rows that apply, clamped. The text is only inspected. */
export function weighMessage(rules: readonly WeightRule[], text: string, addressed: boolean): { weight: number; rules: string[] } {
  const t = text.trim().toLowerCase();
  const hit = rules.filter((r) => applies(r, t, addressed));
  const product = hit.reduce((w, r) => w * r.weight, 1);
  return { weight: Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, product)), rules: hit.map((r) => r.name) };
}

export const defaultWeigh: WeighFn = (text, addressed) => weighMessage(DEFAULT_RULES, text, addressed);

/** `WAKE_RULES_PATH` refuses to be written by the agent unless it parses (called from `assertAgentWritable`). */
export function validateWakeRulesWrite(content: string | Uint8Array): void {
  const text = typeof content === "string" ? content : Buffer.from(content).toString("utf-8");
  try {
    parseWakeRules(text);
  } catch (err) {
    if (!(err instanceof WakeRulesError)) throw err;
    throw new Error(`EINVAL: '${WAKE_RULES_PATH}' was not changed, the table is invalid: ${err.message}. Fix it and write again; the file keeps its previous content.`);
  }
}

/**
 * The live table: seeds the file if it is missing, re-reads it for every message and re-parses only when the text changed.
 * Never throws: a file that cannot be read or parsed leaves the last good table in force.
 */
export function createWakeRules(opts: { fs: VirtualFs; logger?: Logger }): { weigh: WeighFn; rules: () => readonly WeightRule[] } {
  const log = (opts.logger ?? noopLogger).withTag("wake-rules");
  let rules: readonly WeightRule[] = DEFAULT_RULES;
  let loadedText: string | undefined;
  let badText: string | undefined;

  const refresh = () => {
    try {
      if (!opts.fs.exists(WAKE_RULES_PATH)) {
        opts.fs.writeFile(WAKE_RULES_PATH, renderWakeRules(DEFAULT_RULES));
        log.info(`created ${WAKE_RULES_PATH} with the default rules`);
      }
      const text = opts.fs.readText(WAKE_RULES_PATH);
      if (text === loadedText || text === badText) return;
      try {
        const parsed = parseWakeRules(text);
        const first = loadedText === undefined;
        rules = parsed;
        loadedText = text;
        badText = undefined;
        log.info(`${first ? "loaded" : "reloaded"} ${parsed.length} wake rule(s) from ${WAKE_RULES_PATH}`);
      } catch (err) {
        badText = text; // warn once per bad text, keep the last good table
        log.warn(`${WAKE_RULES_PATH} is invalid, keeping the previous rules: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      log.error(`could not read ${WAKE_RULES_PATH}, keeping the previous rules: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  refresh();
  return {
    weigh: (text, addressed) => {
      refresh();
      return weighMessage(rules, text, addressed);
    },
    rules: () => rules,
  };
}
