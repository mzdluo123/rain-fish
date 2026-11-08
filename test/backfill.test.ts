import { describe, expect, it } from "bun:test";
import { backfillAll, backfillGroup } from "../src/backfill.js";
import { openDb } from "../src/db/open.js";
import { MessageStore } from "../src/store.js";
import type { BackfillConfig, GroupHistoryPage, GroupMessage, QQHistoryApi } from "../src/types.js";
import { memoryEventLog, recordingLogger } from "./helpers.js";

const NOW = 1_800_000_000;
const DAY = 86_400;
const cfg: BackfillConfig = { minMessages: 100, maxAgeSeconds: 5 * DAY };

interface Item { seq: number; ts: number; text?: string } // no text = a message the bot cannot use (e.g. a recalled one)

/**
 * A fake group history: seq 1..n, oldest first. Like NapCat, a call returns at most `cap` items ending at
 * `beforeSeq` (inclusive), oldest first, and reports the oldest item it returned even if it had no text.
 */
function fakeHistory(groups: Record<string, Item[]>, o: { cap?: number; failGroup?: string } = {}) {
  const calls: { groupId: string; before: string | undefined; count: number }[] = [];
  const api: QQHistoryApi = {
    async getGroupHistory(groupId, before, count): Promise<GroupHistoryPage> {
      calls.push({ groupId, before, count });
      if (groupId === o.failGroup) throw new Error("API says no");
      const all = groups[groupId] ?? [];
      const upto = before === undefined ? all : all.filter((i) => i.seq <= Number(before));
      const page = upto.slice(-Math.min(count, o.cap ?? count));
      const messages: GroupMessage[] = page
        .filter((i) => i.text !== "")
        .map((i) => ({ platform: "qq", groupId, messageId: `m${i.seq}`, userId: "42", nickname: "Alice", ts: i.ts, text: i.text ?? `消息${i.seq}`, selfId: "1", isSelf: false, mentionsSelf: false }));
      const first = page[0];
      return { messages, oldest: first ? { seq: String(first.seq), ts: first.ts } : undefined };
    },
    async getGroupList() {
      calls.push({ groupId: "(list)", before: undefined, count: 0 });
      return Object.keys(groups);
    },
  };
  return { api, calls };
}

/** n messages, one per minute, the newest `ageOfNewest` seconds old. */
const recentItems = (n: number, ageOfNewestSec = 60): Item[] => Array.from({ length: n }, (_, i) => ({ seq: i + 1, ts: NOW - ageOfNewestSec - (n - 1 - i) * 60 }));
const setup = () => {
  const store = new MessageStore(openDb(":memory:"));
  const rec = recordingLogger();
  return { store, rec };
};
const ids = (store: MessageStore, g: string) => store.countGroup(g);

describe("backfillGroup", () => {
  it("leaves a group alone that already has enough messages", async () => {
    const { store } = setup();
    for (let i = 0; i < 100; i++) store.insert({ platform: "qq", groupId: "1", messageId: `x${i}`, userId: "1", nickname: "A", ts: 1, text: "旧" });
    const { api, calls } = fakeHistory({ "1": recentItems(300) });
    expect(await backfillGroup(api, store, "1", cfg, { now: () => NOW })).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("pulls the latest 100 messages for an empty group, with one call when they are all recent", async () => {
    const { store } = setup();
    const { api, calls } = fakeHistory({ "1": recentItems(300) });
    expect(await backfillGroup(api, store, "1", cfg, { now: () => NOW })).toBe(100);
    expect(calls).toEqual([{ groupId: "1", before: undefined, count: 100 }]);
    expect(store.get("qq", "1", "m300")).toBeDefined(); // the newest
    expect(store.get("qq", "1", "m201")).toBeDefined();
    expect(store.get("qq", "1", "m200")).toBeUndefined(); // nothing beyond the 100 newest
  });

  it("keeps pulling older pages while there are fewer than 100 recent messages, when the server returns small pages", async () => {
    const { store } = setup();
    const { api, calls } = fakeHistory({ "1": recentItems(300) }, { cap: 40 });
    await backfillGroup(api, store, "1", cfg, { now: () => NOW });
    expect(calls.map((c) => c.before)).toEqual([undefined, "261", "222"]); // each page ends at the oldest seq of the previous one (inclusive)
    expect(ids(store, "1")).toBe(118); // 40 + 39 + 39: the boundary message of each later page was already seen
  });

  it("never stores a message older than the age limit, and stops paging once it reaches one", async () => {
    const { store } = setup();
    // 30 messages within the last 5 days, then 200 older than that
    const old = Array.from({ length: 200 }, (_, i) => ({ seq: i + 1, ts: NOW - 6 * DAY - (200 - i) * 60 }));
    const fresh = Array.from({ length: 30 }, (_, i) => ({ seq: 201 + i, ts: NOW - 4 * DAY + i * 60 }));
    const { api, calls } = fakeHistory({ "1": [...old, ...fresh] });
    expect(await backfillGroup(api, store, "1", cfg, { now: () => NOW })).toBe(30);
    expect(calls).toHaveLength(1); // the one page already contained messages older than the limit: nothing further back can qualify
    expect(store.countGroup("1")).toBe(30);
    expect(store.get("qq", "1", "m200")).toBeUndefined();
    expect(store.get("qq", "1", "m201")).toBeDefined();
  });

  it("goes on past pages that are entirely recent but short of 100, and stops at the age limit", async () => {
    const { store } = setup();
    const old = Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, ts: NOW - 9 * DAY + i }));
    const fresh = Array.from({ length: 70 }, (_, i) => ({ seq: 51 + i, ts: NOW - 3 * DAY + i * 60 }));
    const { api, calls } = fakeHistory({ "1": [...old, ...fresh] }, { cap: 50 });
    expect(await backfillGroup(api, store, "1", cfg, { now: () => NOW })).toBe(70);
    expect(calls.map((c) => c.before)).toEqual([undefined, "71"]); // second page crosses the limit -> stop
  });

  it("stops when the history is exhausted", async () => {
    const { store, rec } = setup();
    const { api, calls } = fakeHistory({ "1": recentItems(20) });
    expect(await backfillGroup(api, store, "1", cfg, { now: () => NOW, logger: rec.logger })).toBe(20);
    expect(calls).toHaveLength(2); // the second call returns the same page: no progress, history is over
    expect(rec.messages.some((m) => m.includes("history exhausted"))).toBe(true);
    expect(await backfillGroup(fakeHistory({}).api, store, "empty", cfg, { now: () => NOW })).toBe(0);
  });

  it("does not stall on pages made of messages without text: they still move the cursor back", async () => {
    const { store } = setup();
    const items = recentItems(300).map((i) => (i.seq > 250 ? { ...i, text: "" } : i)); // newest 50 unusable
    const { api, calls } = fakeHistory({ "1": items }, { cap: 60 });
    await backfillGroup(api, store, "1", cfg, { now: () => NOW });
    expect(calls.length).toBeGreaterThan(1);
    expect(ids(store, "1")).toBeGreaterThanOrEqual(100);
    expect(store.get("qq", "1", "m251")).toBeUndefined();
  });

  it("is idempotent: messages already stored are not duplicated", async () => {
    const { store } = setup();
    const { api } = fakeHistory({ "1": recentItems(300) });
    await backfillGroup(api, store, "1", cfg, { now: () => NOW });
    store.insert({ platform: "qq", groupId: "1", messageId: "extra", userId: "1", nickname: "A", ts: NOW, text: "x" }); // (a stray extra message)
    expect(await backfillGroup(api, store, "1", { ...cfg, minMessages: 150 }, { now: () => NOW })).toBe(99); // 201..300 were stored before; only 102..200 are new
  });

  it("stored messages are searchable", async () => {
    const { store } = setup();
    const { api } = fakeHistory({ "1": [{ seq: 1, ts: NOW - 100, text: "周末喝牛奶" }] });
    await backfillGroup(api, store, "1", cfg, { now: () => NOW });
    expect(store.search({ query: "牛奶", groupId: "1" })).toHaveLength(1);
  });
});

describe("backfillAll", () => {
  it("with an allowlist, backfills exactly those groups without listing groups", async () => {
    const { store } = setup();
    const { api, calls } = fakeHistory({ "1": recentItems(5), "2": recentItems(5), "3": recentItems(5) });
    await backfillAll(api, store, new Set(["1", "3"]), cfg, { now: () => NOW });
    expect(calls.some((c) => c.groupId === "(list)")).toBe(false);
    expect([ids(store, "1"), ids(store, "2"), ids(store, "3")]).toEqual([5, 0, 5]);
  });

  it("without an allowlist, uses every group the bot is in", async () => {
    const { store } = setup();
    const { api } = fakeHistory({ "1": recentItems(5), "2": recentItems(5) });
    await backfillAll(api, store, undefined, cfg, { now: () => NOW });
    expect([ids(store, "1"), ids(store, "2")]).toEqual([5, 5]);
  });

  it("a failing group is logged and the others still get their history", async () => {
    const { store, rec } = setup();
    const { api } = fakeHistory({ "1": recentItems(5), "2": recentItems(5) }, { failGroup: "1" });
    await backfillAll(api, store, undefined, cfg, { now: () => NOW, logger: rec.logger });
    expect(rec.entries).toContainEqual({ level: "error", msg: expect.stringContaining("API says no") });
    expect(ids(store, "2")).toBe(5);
  });

  it("minMessages = 0 turns it off completely", async () => {
    const { store } = setup();
    const { api, calls } = fakeHistory({ "1": recentItems(5) });
    await backfillAll(api, store, undefined, { ...cfg, minMessages: 0 }, { now: () => NOW });
    expect(calls).toHaveLength(0);
  });
});

describe("backfill event log", () => {
  it("records start/done with the stop reason, and skip / fail", async () => {
    const trace = memoryEventLog();
    const { store } = setup();
    const { api } = fakeHistory({ "1": recentItems(300), "2": recentItems(5), "3": recentItems(5) }, { failGroup: "3" });
    await backfillAll(api, store, new Set(["1", "2", "3"]), cfg, { now: () => NOW, events: trace.events });
    const byGroup = (ev: string) => Object.fromEntries(trace.records(ev).map((r) => [r.group, r]));
    expect(byGroup("backfill.done")["1"]).toMatchObject({ stored: 100, pages: 1, reason: "enough" });
    expect(byGroup("backfill.done")["2"]).toMatchObject({ stored: 5, reason: "history_exhausted" });
    expect(byGroup("backfill.fail")["3"].error).toMatchObject({ message: "API says no" });

    await backfillAll(api, store, new Set(["1"]), cfg, { now: () => NOW, events: trace.events });
    expect(trace.records("backfill.skip")[0]).toMatchObject({ group: "1", have: 100, min: 100 });
  });
});
