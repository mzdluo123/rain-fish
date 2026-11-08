import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate } from "../src/db/migrate.js";
import { migrations } from "../src/db/migrations/index.js";
import { openDb } from "../src/db/open.js";
import { MessageStore } from "../src/store.js";
import type { StoredMessage } from "../src/types.js";

let n = 0;
const msg = (text: string, over: Partial<StoredMessage> = {}): StoredMessage => ({
  platform: "qq",
  groupId: "100",
  messageId: String(++n),
  userId: "1",
  nickname: "Alice",
  ts: 1_700_000_000,
  text,
  ...over,
});

let store: MessageStore;
beforeEach(() => {
  store = new MessageStore(openDb(":memory:"));
});

describe("search", () => {
  it("finds Chinese words, including 2-character words inside longer text", () => {
    store.insert(msg("今天下雨了，雪乃喜欢喝热牛奶"));
    store.insert(msg("明天去爬山"));
    expect(store.search({ query: "牛奶" }).map((h) => h.text)).toEqual(["今天下雨了，雪乃喜欢喝热牛奶"]);
    expect(store.search({ query: "下雨" })).toHaveLength(1);
  });

  it("finds Japanese and English, case-insensitively, and folds full-width forms", () => {
    store.insert(msg("これは日本語のテストです"));
    store.insert(msg("Deploy finished ＯＫ"));
    expect(store.search({ query: "日本語" })).toHaveLength(1);
    expect(store.search({ query: "deploy" })).toHaveLength(1);
    expect(store.search({ query: "ok" })).toHaveLength(1);
  });

  it("requires every keyword (AND)", () => {
    store.insert(msg("喜欢喝牛奶"));
    store.insert(msg("喜欢爬山"));
    expect(store.search({ query: "喜欢 牛奶" })).toHaveLength(1);
  });

  it("treats FTS syntax in user input as plain text and never throws", () => {
    store.insert(msg("hello world"));
    for (const q of ['"', "hello AND", "hello*", "NEAR(a b)", "col:hello", "-", "(", "'; DROP TABLE messages;--"]) {
      expect(() => store.search({ query: q })).not.toThrow();
    }
    expect(store.search({ query: "hello OR nothing" })).toHaveLength(0); // OR is just a token
    expect(store.search({ query: "，。！" })).toEqual([]); // no word tokens -> no results
  });

  it("filters by group, sender (id or nickname) and time range", () => {
    store.insert(msg("牛奶 a", { groupId: "100", userId: "1", nickname: "Alice", ts: 1000 }));
    store.insert(msg("牛奶 b", { groupId: "200", userId: "2", nickname: "Bob", ts: 2000 }));
    store.insert(msg("牛奶 c", { groupId: "100", userId: "2", nickname: "Bob", ts: 3000 }));
    const texts = (q: Parameters<typeof store.search>[0]) => store.search(q).map((h) => h.text).sort();
    expect(texts({ query: "牛奶", groupId: "100" })).toEqual(["牛奶 a", "牛奶 c"]);
    expect(texts({ query: "牛奶", sender: "Bob" })).toEqual(["牛奶 b", "牛奶 c"]);
    expect(texts({ query: "牛奶", sender: "2", groupId: "100" })).toEqual(["牛奶 c"]);
    expect(texts({ query: "牛奶", since: 2000, until: 2500 })).toEqual(["牛奶 b"]);
  });

  it("ranks more relevant (shorter, denser) matches first and honours limit", () => {
    store.insert(msg("猫 猫 猫"));
    store.insert(msg("今天天气很好所以我们一起出门散步还顺便看到了一只猫在晒太阳"));
    const hits = store.search({ query: "猫" });
    expect(hits[0]!.text).toBe("猫 猫 猫");
    expect(store.search({ query: "猫", limit: 1 })).toHaveLength(1);
  });
});

describe("insert", () => {
  it("is idempotent per (platform, group, message id) and does not double-index", () => {
    const m = msg("重复的消息");
    expect(store.insert(m)).toBe(true);
    expect(store.insert({ ...m })).toBe(false);
    expect(store.search({ query: "重复" })).toHaveLength(1);
    expect(store.insert({ ...m, groupId: "other" })).toBe(true); // same id, different group
  });
});

describe("persistence and migrations", () => {
  it("reopening a file database keeps data and does not re-migrate", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "store-")), "nested", "m.db");
    const db1 = openDb(file);
    new MessageStore(db1).insert(msg("持久化测试"));
    db1.close();
    const db2 = openDb(file);
    expect(new MessageStore(db2).search({ query: "持久化" })).toHaveLength(1);
  });

  it("migration 2 backfills the index for messages stored before it existed", () => {
    const db = new Database(":memory:");
    migrate(db, migrations.slice(0, 1));
    db.query("INSERT INTO messages (platform, group_id, message_id, user_id, nickname, ts, text) VALUES ('qq','1','9','1','A',1,'旧消息里有牛奶')").run();
    expect(migrate(db, migrations)).toEqual([2, 3, 4]);
    const hit = db.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"牛奶\"'").all();
    expect(hit).toHaveLength(1);
  });
});
