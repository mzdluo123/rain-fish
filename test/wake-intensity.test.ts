import { describe, expect, it } from "bun:test";
import { WakeIntensity } from "../src/wake-intensity.js";

const params = { decayPerSec: 0.4, threshold: 0.3 };

describe("WakeIntensity (exponential Hawkes excitation)", () => {
  it("starts cold: nothing to wait for", () => {
    const h = new WakeIntensity(params);
    expect(h.at(1_000)).toBe(0);
    expect(h.quietIn(1_000)).toBe(0);
  });

  it("one ordinary message needs ln(1/threshold)/beta seconds to fade (~3 s)", () => {
    const h = new WakeIntensity(params);
    h.add(0, 1);
    expect(h.quietIn(0)).toBeCloseTo((Math.log(1 / 0.3) / 0.4) * 1000, 6);
    expect(h.quietIn(0)).toBeCloseTo(3_010, -1);
  });

  it("decays by half every ln 2 / beta seconds", () => {
    const h = new WakeIntensity(params);
    h.add(0, 2);
    expect(h.at((Math.LN2 / 0.4) * 1000)).toBeCloseTo(1, 9);
  });

  it("excitation of a burst adds up, so the quiet time grows with it", () => {
    const h = new WakeIntensity(params);
    for (let i = 0; i < 5; i++) h.add(i * 200, 1);
    expect(h.at(800)).toBeGreaterThan(3.5);
    expect(h.quietIn(800)).toBeGreaterThan(6_000);
  });

  it("the incremental update equals the full sum over the history", () => {
    const times = [0, 300, 1_100, 1_200, 4_000];
    const weights = [1, 0.5, 2.5, 1, 1];
    const h = new WakeIntensity(params);
    times.forEach((t, i) => h.add(t, weights[i]!));
    const now = 5_000;
    const direct = times.reduce((sum, t, i) => sum + weights[i]! * Math.exp((-0.4 * (now - t)) / 1000), 0);
    expect(h.at(now)).toBeCloseTo(direct, 9);
  });

  it("a clock that steps back neither grows the excitation nor breaks it", () => {
    const h = new WakeIntensity(params);
    h.add(10_000, 1);
    expect(h.at(5_000)).toBe(1);
    h.add(5_000, 1);
    expect(h.at(10_000)).toBeCloseTo(2, 9);
  });

  it("never cools with a zero decay: the caller's maximum wait has to end it", () => {
    const h = new WakeIntensity({ decayPerSec: 0, threshold: 0.3 });
    h.add(0, 1);
    expect(h.quietIn(60_000)).toBe(Number.POSITIVE_INFINITY);
  });
});
