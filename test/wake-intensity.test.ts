import { describe, expect, it } from "bun:test";
import { messageWeight, weighMessage, WakeIntensity } from "../src/wake-intensity.js";

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

describe("messageWeight (keyword table)", () => {
  it("ordinary text counts as 1", () => expect(messageWeight("今天吃什么", false)).toBe(1));
  it("questions, messages to the bot and help requests count less (answer sooner)", () => {
    expect(messageWeight("有人在吗？", false)).toBe(0.5);
    expect(messageWeight("what?", false)).toBe(0.5);
    expect(messageWeight("今天吃啥", true)).toBe(0.5);
    expect(messageWeight("bot 你怎么看", false)).toBeCloseTo(0.3, 9); // calls_bot x asks_help
    expect(messageWeight("为什么会这样", false)).toBe(0.6);
  });
  it("unfinished sentences count more (wait for the rest)", () => {
    expect(messageWeight("我觉得吧，", false)).toBe(2.5);
    expect(messageWeight("首先我们要", false)).toBe(2.5);
    expect(messageWeight("等一下...", false)).toBe(2.5);
    expect(messageWeight("还有一点：", true)).toBe(1.25);
  });
  it("short closings and lone pictures count less, a long text that happens to contain 谢谢 does not", () => {
    expect(messageWeight("谢谢", false)).toBe(0.8);
    expect(messageWeight("[图片]", false)).toBe(0.3);
    expect(messageWeight("[图片][表情]", false)).toBe(0.3);
    expect(messageWeight("谢谢你昨天帮忙整理的那份资料，真的省了很多时间", false)).toBe(1);
    expect(messageWeight("看这个[图片]", false)).toBe(1);
  });
  it("arguments and 'be quiet' commands hold the bot back", () => {
    expect(messageWeight("你胡说", false)).toBe(1.5);
    expect(messageWeight("闭嘴", false)).toBe(3);
  });
  it("matching ignores case and the product is clamped", () => {
    expect(messageWeight("BOT 在吗？", false)).toBeCloseTo(0.25, 9);
    expect(messageWeight("bot 帮我看看？", true)).toBe(0.2); // 0.5^3 x 0.6 = 0.075 -> floor
    expect(messageWeight("首先，你才不对，闭嘴", false)).toBeLessThanOrEqual(4);
  });
  it("reports which rows applied", () => {
    expect(weighMessage("bot 你怎么看？", true).rules).toEqual(["addressed", "question", "calls_bot", "asks_help"]);
    expect(weighMessage("今天吃什么", false).rules).toEqual([]);
  });
});
