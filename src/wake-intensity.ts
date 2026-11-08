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
