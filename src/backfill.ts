import { noopLogger } from "./logger.js";
import type { MessageStore } from "./store.js";
import { noopEventLog } from "./trace/event-log.js";
import type { BackfillConfig, EventLog, GroupMessage, Logger, QQHistoryApi } from "./types.js";

const PAGE_SIZE = 100;
/** Bounds the number of API calls per group if the server keeps returning pages that never reach the cutoff. */
const MAX_PAGES = 20;

export interface BackfillOptions {
  /** Unix seconds; replaceable in tests. */
  now?: () => number;
  logger?: Logger;
  events?: EventLog;
}

/**
 * Fills a nearly empty group from the QQ API. A group that already has `minMessages` stored messages is left alone.
 * Otherwise history is pulled newest-first, a page at a time, keeping only messages newer than the age limit,
 * until `minMessages` of those are collected, the history reaches a message older than the limit (everything
 * further back is older still), or it ends. The messages are only stored (searchable, visible to
 * `search_messages`); they do not wake the agent. Returns how many were newly stored.
 */
export async function backfillGroup(api: QQHistoryApi, store: MessageStore, groupId: string, cfg: BackfillConfig, opts: BackfillOptions = {}): Promise<number> {
  const log = (opts.logger ?? noopLogger).withTag("backfill");
  const events = (opts.events ?? noopEventLog).child({ group: groupId });
  const have = store.countGroup(groupId);
  if (have >= cfg.minMessages) {
    log.debug(`group ${groupId}: ${have} stored message(s), no backfill needed`);
    events.emit("backfill.skip", { have, min: cfg.minMessages });
    return 0;
  }
  const t0 = Date.now();
  events.emit("backfill.start", { have, min: cfg.minMessages, max_age_s: cfg.maxAgeSeconds });

  const cutoff = (opts.now ?? (() => Math.floor(Date.now() / 1000)))() - cfg.maxAgeSeconds;
  const seen = new Set<string>();
  const recent: GroupMessage[] = [];
  let before: string | undefined;
  let reachedCutoff = false;
  let pages = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const p = await api.getGroupHistory(groupId, before, PAGE_SIZE);
    pages++;
    if (!p.oldest || p.oldest.seq === before) break; // empty page, or the server did not move back: history is exhausted
    for (const m of p.messages) {
      if (seen.has(m.messageId)) continue; // pages overlap at their boundary
      seen.add(m.messageId);
      if (m.ts >= cutoff) recent.push(m);
    }
    if (p.oldest.ts < cutoff) {
      reachedCutoff = true;
      break;
    }
    if (recent.length >= cfg.minMessages) break;
    before = p.oldest.seq;
  }

  recent.sort((a, b) => a.ts - b.ts);
  let stored = 0;
  for (const m of recent) if (store.insert(m)) stored++;
  const why = recent.length >= cfg.minMessages ? "" : reachedCutoff ? " (no more messages inside the age limit)" : " (history exhausted)";
  log.success(`group ${groupId}: stored ${stored} message(s) from history, had ${have}${why}`);
  events.emit("backfill.done", {
    have,
    stored,
    collected: recent.length,
    pages,
    reason: recent.length >= cfg.minMessages ? "enough" : reachedCutoff ? "age_limit" : "history_exhausted",
    oldest_ts: recent[0]?.ts,
    ms: Date.now() - t0,
  });
  return stored;
}

/**
 * At startup: backfill every handled group (`groups`), or, when no allowlist is set, every group the bot is in.
 * A failing group is logged and skipped; failing to list the groups throws, so the caller may retry.
 */
export async function backfillAll(
  api: QQHistoryApi,
  store: MessageStore,
  groups: ReadonlySet<string> | undefined,
  cfg: BackfillConfig,
  opts: BackfillOptions = {},
): Promise<void> {
  if (cfg.minMessages === 0) return;
  const log = (opts.logger ?? noopLogger).withTag("backfill");
  const ids = groups ? [...groups] : await api.getGroupList();
  for (const groupId of ids) {
    try {
      await backfillGroup(api, store, groupId, cfg, opts);
    } catch (err) {
      log.error(`group ${groupId}: history backfill failed: ${err instanceof Error ? err.message : String(err)}`);
      (opts.events ?? noopEventLog).emit("backfill.fail", { group: groupId, error: err });
    }
  }
}
