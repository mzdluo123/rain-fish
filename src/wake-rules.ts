/**
 * The keyword/heat table and experience-level timing of the wake-up scheduler, kept in the agent's own virtual filesystem as `/wake-rules.yaml` so the
 * agent can tune how quickly it reacts. The file is YAML (Bun's built-in parser, a zod schema for the shape); it is the one
 * non-Markdown, non-Python file the agent may write (see `assertAgentFileType`).
 *
 *   - If it does not exist it is created from `DEFAULT_RULES` (`createWakeRules`, also if it disappears later).
 *   - Every message re-reads it; a changed text is parsed and takes effect at once (reload), whoever wrote it.
 *   - The agent's write/edit of this path is validated first (`assertAgentWritable` -> `parseWakeRulesFile`): a file that does
 *     not parse is refused with the reason and nothing is written, so the file on disk is always valid. If it was broken
 *     from outside anyway (host `bun run fs`), the last good table stays in force and a warning is logged.
 *
 * It is agent-writable, so group members can influence it. What it can do is bounded: plain substring tests only (no
 * regex), at most `MAX_RULES` rules, weights in [`MIN_RULE_WEIGHT`, `MAX_RULE_WEIGHT`], a product clamped to [`MIN_WEIGHT`, `MAX_WEIGHT`],
 * optional `timing` fields bounded to safe ranges, and the wake-up always stays under `WAKE_MAX_WAIT_SECONDS` / `WAKE_ADDRESSED_MAX_WAIT_SECONDS` / `WAKE_MAX_BATCH`.
 */
import { z } from "zod";
import type { Logger, WakeRulesFile, WakeTiming, WeighFn, WeightRule } from "./types.js";
import { noopLogger } from "./logger.js";
import type { VirtualFs } from "./vfs.js";
import { PERSONA_PATH } from "./context/persona.js";

export const WAKE_RULES_PATH = "/wake-rules.yaml";
/** The Markdown table of earlier versions; replaced (deleted) when the YAML file is first created. */
export const LEGACY_WAKE_RULES_PATH = "/wake-rules.md";
export const MAX_RULES = 40;
export const MAX_WORDS_PER_CELL = 30;
export const MAX_WORD_CHARS = 12;
export const MIN_RULE_WEIGHT = 0.1;
export const MAX_RULE_WEIGHT = 5;
/** Final clamp of a message's weight (the product of all rules that apply). */
export const MIN_WEIGHT = 0.2;
export const MAX_WEIGHT = 4;

/** Bounds for the optional `timing` section in `/wake-rules.yaml`. */
export const MIN_CHAT_MEAN_SECONDS = 10;
export const MAX_CHAT_MEAN_SECONDS = 120;
export const MIN_ADDRESSED_MEAN_SECONDS = 0;
export const MAX_ADDRESSED_MEAN_SECONDS = 10;
export const MIN_DECAY_PER_SEC = 0.15;
export const MAX_DECAY_PER_SEC = 1;
export const MIN_QUIET_THRESHOLD = 0.1;
export const MAX_QUIET_THRESHOLD = 0.8;

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

const HEADER = `# Wake-up timing & heat rules. Every message heats the chat by a weight; you are woken once the heat has cooled down
# plus a random reaction time. Change \`timing\` or \`rules\` with \`edit\`. An invalid file is refused with the reason and stays as it was.
#
# Optional top-level \`timing\` section (omit any field to keep the host default):
#   chat_mean_seconds      ${MIN_CHAT_MEAN_SECONDS}-${MAX_CHAT_MEAN_SECONDS} (default 45): mean random reaction time (seconds) for ordinary chatter after the chat is quiet
#   addressed_mean_seconds ${MIN_ADDRESSED_MEAN_SECONDS}-${MAX_ADDRESSED_MEAN_SECONDS} (default 1): same once a pending message @-mentions or replies to you (0 = no extra delay)
#   decay_per_second       ${MIN_DECAY_PER_SEC}-${MAX_DECAY_PER_SEC} (default 0.4): how fast a burst of messages cools down per second (half-life = ln 2 / decay_per_second)
#   quiet_threshold        ${MIN_QUIET_THRESHOLD}-${MAX_QUIET_THRESHOLD} (default 0.3): heat threshold where the chat counts as quiet (smaller = wait longer after a burst)
#
# Heat rules (\`rules\`, at most ${MAX_RULES}):
#   weight < 1: wake sooner (someone waits for an answer, the topic is closed)
#   weight > 1: wait longer (the sentence is unfinished, an argument is going on)
# A message that matches several rules gets the product of their weights, clamped to ${MIN_WEIGHT}-${MAX_WEIGHT}. No match = 1.
#
# Fields of a rule:
#   name      unique; 1-24 letters, digits, "_", "-" or Chinese characters
#   weight    ${MIN_RULE_WEIGHT}-${MAX_RULE_WEIGHT}
#   contains / starts / ends
#             lists of words (case-insensitive, up to ${MAX_WORDS_PER_CELL} words of up to ${MAX_WORD_CHARS} characters); the rule matches when the
#             message contains / starts with / ends with any of them
#   max_len   optional; a longer message never matches (keeps "closing" rules to short lines)
#   special   optional; addressed = someone @-mentions or replies to you; placeholder = the message is only a placeholder like [图片]
# The conditions of one rule are alternatives (any one matches); give at least one.
`;

/** The file's text for a set of rules and optional timing (what is seeded; `parseWakeRulesFile(renderWakeRules(r, t))` gives `{ timing: t, rules: r }` back). */
export function renderWakeRules(rules: readonly WeightRule[], timing?: WakeTiming): string {
  const timingLines: string[] = [];
  if (timing) {
    if (timing.chatMeanSeconds !== undefined) timingLines.push(`  chat_mean_seconds: ${timing.chatMeanSeconds}`);
    if (timing.addressedMeanSeconds !== undefined) timingLines.push(`  addressed_mean_seconds: ${timing.addressedMeanSeconds}`);
    if (timing.decayPerSec !== undefined) timingLines.push(`  decay_per_second: ${timing.decayPerSec}`);
    if (timing.quietThreshold !== undefined) timingLines.push(`  quiet_threshold: ${timing.quietThreshold}`);
  }
  const timingBlock = timingLines.length > 0 ? `timing:\n${timingLines.join("\n")}\n\n` : "";
  const list = (key: string, xs: readonly string[]) => (xs.length ? [`  ${key}: [${xs.map((x) => JSON.stringify(x)).join(", ")}]`] : []);
  const entries = rules.map((r) =>
    [`- name: ${r.name}`, `  weight: ${r.weight}`, ...list("contains", r.contains), ...list("starts", r.starts), ...list("ends", r.ends), ...(r.maxLen !== undefined ? [`  max_len: ${r.maxLen}`] : []), ...(r.special ? [`  special: ${r.special}`] : [])].join("\n"),
  );
  return `${HEADER}\n${timingBlock}rules:\n${entries.join("\n").replace(/^/gm, "  ")}\n`;
}

export class WakeRulesError extends Error {}

const boundedNumber = (min: number, max: number) =>
  z
    .number(`must be a number from ${min} to ${max}`)
    .min(min, `must be at least ${min}`)
    .max(max, `must be at most ${max}`)
    .optional();

const timingSchema = z
  .strictObject({
    chat_mean_seconds: boundedNumber(MIN_CHAT_MEAN_SECONDS, MAX_CHAT_MEAN_SECONDS),
    addressed_mean_seconds: boundedNumber(MIN_ADDRESSED_MEAN_SECONDS, MAX_ADDRESSED_MEAN_SECONDS),
    decay_per_second: boundedNumber(MIN_DECAY_PER_SEC, MAX_DECAY_PER_SEC),
    quiet_threshold: boundedNumber(MIN_QUIET_THRESHOLD, MAX_QUIET_THRESHOLD),
  })
  .optional();

const words = z
  .array(z.string().refine((w) => w.length > 0 && [...w].length <= MAX_WORD_CHARS, `each word must be 1-${MAX_WORD_CHARS} characters`))
  .max(MAX_WORDS_PER_CELL, `at most ${MAX_WORDS_PER_CELL} words`)
  .optional();

const ruleSchema = z
  .strictObject({
    name: z.string().regex(/^[A-Za-z0-9_\-一-鿿]{1,24}$/, 'must be 1-24 letters, digits, "_", "-" or Chinese characters (quote it if it looks like a number)'),
    weight: z.number(`must be a number from ${MIN_RULE_WEIGHT} to ${MAX_RULE_WEIGHT}`).min(MIN_RULE_WEIGHT, `must be at least ${MIN_RULE_WEIGHT}`).max(MAX_RULE_WEIGHT, `must be at most ${MAX_RULE_WEIGHT}`),
    contains: words,
    starts: words,
    ends: words,
    max_len: z.number().int("must be a whole number").min(1).max(500, "must be from 1 to 500").optional(),
    special: z.enum(["addressed", "placeholder"], "must be addressed or placeholder").optional(),
  })
  .refine((r) => r.contains?.length || r.starts?.length || r.ends?.length || r.special, "has no condition (fill contains, starts, ends or special)");

const fileSchema = z.strictObject({
  timing: timingSchema,
  rules: z.array(ruleSchema).max(MAX_RULES, `at most ${MAX_RULES} rules`),
});

/** Parses `/wake-rules.yaml` (both `timing` and `rules`). Throws `WakeRulesError` naming the rule/field when anything is off. */
export function parseWakeRulesFile(text: string): WakeRulesFile {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (err) {
    throw new WakeRulesError(`not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new WakeRulesError("the file must be a mapping with a `rules` list");
  const r = fileSchema.safeParse(doc);
  if (!r.success) {
    const where = (path: PropertyKey[]) => path.map((k, i) => (typeof k === "number" ? `[${k + 1}]` : i ? `.${String(k)}` : String(k))).join("");
    throw new WakeRulesError(r.error.issues.slice(0, 3).map((i) => `${where(i.path) || "file"}: ${i.message}`).join("; "));
  }
  const names = new Set<string>();
  const rules = r.data.rules.map((x) => {
    if (names.has(x.name)) throw new WakeRulesError(`rules: the name "${x.name}" is used twice`);
    names.add(x.name);
    const lower = (xs?: string[]) => (xs ?? []).map((w) => w.toLowerCase());
    const rule: WeightRule = { name: x.name, weight: x.weight, contains: lower(x.contains), starts: lower(x.starts), ends: lower(x.ends) };
    if (x.max_len !== undefined) rule.maxLen = x.max_len;
    if (x.special) rule.special = x.special;
    return rule;
  });
  const t = r.data.timing;
  const timing: WakeTiming = {};
  if (t?.chat_mean_seconds !== undefined) timing.chatMeanSeconds = t.chat_mean_seconds;
  if (t?.addressed_mean_seconds !== undefined) timing.addressedMeanSeconds = t.addressed_mean_seconds;
  if (t?.decay_per_second !== undefined) timing.decayPerSec = t.decay_per_second;
  if (t?.quiet_threshold !== undefined) timing.quietThreshold = t.quiet_threshold;
  return Object.keys(timing).length > 0 ? { timing, rules } : { rules };
}

/** Parses the file and returns its `rules` list. Throws `WakeRulesError` naming the rule and field when anything is off. */
export function parseWakeRules(text: string): WeightRule[] {
  return parseWakeRulesFile(text).rules;
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
    parseWakeRulesFile(text);
  } catch (err) {
    if (!(err instanceof WakeRulesError)) throw err;
    throw new Error(`EINVAL: '${WAKE_RULES_PATH}' was not changed, the rules are invalid: ${err.message}. Fix it and write again; the file keeps its previous content.`);
  }
}

/**
 * The live table: seeds the file if it is missing, re-reads it for every message and re-parses only when the text changed.
 * Never throws: a file that cannot be read or parsed leaves the last good table in force.
 */
export function createWakeRules(opts: { fs: VirtualFs; logger?: Logger }): {
  weigh: WeighFn;
  rules: () => readonly WeightRule[];
  timing: () => WakeTiming | undefined;
} {
  const log = (opts.logger ?? noopLogger).withTag("wake-rules");
  let rules: readonly WeightRule[] = DEFAULT_RULES;
  let timing: WakeTiming | undefined;
  let loadedText: string | undefined;
  let badText: string | undefined;

  const refresh = () => {
    try {
      if (!opts.fs.exists(WAKE_RULES_PATH)) {
        opts.fs.writeFile(WAKE_RULES_PATH, renderWakeRules(DEFAULT_RULES));
        log.info(`created ${WAKE_RULES_PATH} with the default rules`);
        if (opts.fs.exists(LEGACY_WAKE_RULES_PATH)) {
          opts.fs.remove(LEGACY_WAKE_RULES_PATH); // the Markdown table is no longer read; keeping it would only mislead
          log.warn(`removed the old ${LEGACY_WAKE_RULES_PATH}: wake rules now live in ${WAKE_RULES_PATH} (reset to the defaults)`);
          if (opts.fs.exists(PERSONA_PATH)) {
            const persona = opts.fs.readText(PERSONA_PATH);
            const fixed = persona.replaceAll(`](${LEGACY_WAKE_RULES_PATH})`, `](${WAKE_RULES_PATH})`);
            if (fixed !== persona) {
              opts.fs.writeFile(PERSONA_PATH, fixed);
              log.info(`pointed the links in ${PERSONA_PATH} at ${WAKE_RULES_PATH}`);
            }
          }
        }
      }
      const text = opts.fs.readText(WAKE_RULES_PATH);
      if (text === loadedText || text === badText) return;
      try {
        const parsed = parseWakeRulesFile(text);
        const first = loadedText === undefined;
        rules = parsed.rules;
        timing = parsed.timing;
        loadedText = text;
        badText = undefined;
        log.info(`${first ? "loaded" : "reloaded"} ${parsed.rules.length} wake rule(s) from ${WAKE_RULES_PATH}`);
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
    rules: () => {
      refresh();
      return rules;
    },
    timing: () => {
      refresh();
      return timing;
    },
  };
}
