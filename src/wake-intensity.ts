/**
 * How "hot" a group chat is, as a one-dimensional exponential-decay Hawkes process.
 *
 * A Poisson process has a constant rate: whatever was said a second ago says nothing about the next second. Chat is
 * not like that: a message makes more messages likely (people answer, add a thought, send the second half of a
 * sentence), and the effect fades. The Hawkes conditional intensity is
 *
 *     lambda(t) = lambda0 + sum_i alpha * w_i * exp(-beta * (t - t_i))
 *
 * `lambda0` (the quiet background rate) cancels out of "when has the burst ended?", and so does `alpha` once the
 * excitation is counted in units of one ordinary message, so what is kept is the excitation
 * `S(t) = sum_i w_i * exp(-beta * (t - t_i))` and the question "how long until S falls below a threshold?".
 *
 * Exponential kernels have no memory beyond the sum itself, so the whole history is two numbers (`S`, last update):
 *
 *     S(t)          = S_last * exp(-beta * (t - t_last))
 *     on a message  : S <- S(t) + w
 *     time to quiet : tau = ln(S(t) / threshold) / beta        (0 if S(t) <= threshold)
 */

export interface IntensityParams {
  /** beta: decay rate of the excitation, per second. Half-life = ln 2 / beta (0.4/s -> ~1.7 s). */
  decayPerSec: number;
  /** The burst counts as over when the excitation has fallen to this many ordinary messages (0.3 -> three quarters of a message has faded). */
  threshold: number;
}

/** Excitation state of one group: O(1) memory, no history queue. */
export class WakeIntensity {
  private s = 0;
  private last = 0;

  constructor(private readonly p: IntensityParams) {}

  /** Excitation at `now` (ms), in units of one ordinary message. */
  at(now: number): number {
    if (this.s === 0) return 0;
    const dt = Math.max(0, now - this.last) / 1000; // a clock that stepped back must not make the excitation grow
    return this.s * Math.exp(-this.p.decayPerSec * dt);
  }

  /** A message with the given weight arrived at `now` (ms). */
  add(now: number, weight: number): void {
    this.s = this.at(now) + weight;
    this.last = Math.max(now, this.last);
  }

  /** Milliseconds from `now` until the excitation is down to the threshold: how long the chat must stay quiet. */
  quietIn(now: number): number {
    const cur = this.at(now);
    if (cur <= this.p.threshold) return 0;
    if (this.p.threshold <= 0 || this.p.decayPerSec <= 0) return Number.POSITIVE_INFINITY; // never cools: the caller's maximum wait ends it
    return (Math.log(cur / this.p.threshold) / this.p.decayPerSec) * 1000;
  }
}

/** One row of the weight table. `weight` multiplies the weight of a message the row applies to; below 1 = the bot comes sooner, above 1 = later. */
interface WeightRule {
  name: string;
  weight: number;
  applies: (text: string, addressed: boolean) => boolean;
}

const has = (words: readonly string[], text: string) => words.some((w) => text.includes(w));
/** The text is only a placeholder like "[图片]" / "[表情]": nothing a member wrote. */
const placeholderOnly = /^(\[[^\]]{1,6}\])+$/;

/**
 * The keyword/heat table. Matching is plain substring/prefix/suffix tests on the lower-cased text (never a regex built from
 * data), all rows that apply are multiplied, and the product is clamped to [MIN_WEIGHT, MAX_WEIGHT]. Edit the table here;
 * it is host code, so neither group members nor the agent can change it.
 */
export const WEIGHT_RULES: readonly WeightRule[] = [
  // --- waiting for an answer: come sooner ---
  { name: "addressed", weight: 0.5, applies: (_t, addressed) => addressed }, // @-mention or reply to the bot
  { name: "question", weight: 0.5, applies: (t) => /[?？]$/.test(t) },
  { name: "calls_bot", weight: 0.5, applies: (t) => has(["bot", "机器人"], t) }, // talks to it without an @
  { name: "asks_help", weight: 0.6, applies: (t) => has(["帮我", "怎么", "为什么", "能不能"], t) },
  // --- the conversation is closing or empty: no reason to wait ---
  { name: "closing", weight: 0.8, applies: (t) => t.length <= 8 && has(["好的", "谢谢", "晚安", "哈哈"], t) },
  { name: "placeholder_only", weight: 0.3, applies: (t) => placeholderOnly.test(t) }, // a lone picture or sticker
  // --- more is coming: wait ---
  { name: "unfinished", weight: 2.5, applies: (t) => /[，、：,:…]$|\.{3}$/.test(t) || /^(首先|第一[点步条]?|其一|先说)/.test(t) },
  { name: "heated", weight: 1.5, applies: (t) => has(["不对", "胡说", "你才"], t) }, // an argument: do not butt in
  { name: "keep_quiet", weight: 3, applies: (t) => has(["别说话", "闭嘴"], t) }, // told to be quiet: hold off
];

export const MIN_WEIGHT = 0.2;
export const MAX_WEIGHT = 4;

/**
 * How strongly one message excites the chat relative to an ordinary message (1), from `WEIGHT_RULES`; `rules` names the rows
 * that applied. The text is only inspected, never forwarded or logged.
 */
export function weighMessage(text: string, addressed: boolean): { weight: number; rules: string[] } {
  const t = text.trim().toLowerCase();
  const hit = WEIGHT_RULES.filter((r) => r.applies(t, addressed));
  const product = hit.reduce((w, r) => w * r.weight, 1);
  return { weight: Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, product)), rules: hit.map((r) => r.name) };
}

export const messageWeight = (text: string, addressed: boolean): number => weighMessage(text, addressed).weight;
