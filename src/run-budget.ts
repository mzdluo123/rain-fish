/**
 * What the agent may post in one run: at most `max` messages, with `gapMs` between consecutive ones. The conversation calls
 * `reset()` when a run (or its reminder turn) starts. The tools run one at a time (`executionMode: "sequential"`), so
 * `acquire` / `commit` never interleave.
 */
export class RunBudget {
  private sent = 0;
  private muted = false;

  constructor(
    readonly max = 6,
    readonly gapMs = 0,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  reset(): void {
    this.sent = 0;
  }

  /**
   * While muted, every post is refused with a tool error (the tools stay declared: changing the tool list would invalidate the provider's
   * prompt cache). Independent of `reset()`; the memory-flush turn mutes and always unmutes.
   */
  mute(): void {
    this.muted = true;
  }

  unmute(): void {
    this.muted = false;
  }

  get used(): number {
    return this.sent;
  }

  /** Call before posting: throws when the run is out of messages, otherwise waits out the gap after the previous one. */
  async acquire(): Promise<void> {
    if (this.muted) throw new Error("Posting is not possible in this turn (memory-saving turn, not a chat turn): nothing was sent. Write what matters to your files instead, then finish.");
    if (this.sent >= this.max) throw new Error(`Message limit reached: at most ${this.max} messages per run. Call stop now.`);
    if (this.sent > 0 && this.gapMs > 0) await this.sleep(this.gapMs);
  }

  /** Call after a message was delivered. */
  commit(): void {
    this.sent++;
  }
}
