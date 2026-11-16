import { noopLogger } from "./logger.js";
import type { GroupMessage, Logger, StoredUpload, UploadArchive, UploadSource } from "./types.js";
import { parseFileRef, type UploadStore } from "./upload-store.js";

/** Consent is parsed from an exact member message, never from agent output or file contents. */
export function createUploadArchive(opts: { store: UploadStore; source: UploadSource; privacy: "ask" | "auto"; logger?: Logger }): UploadArchive {
  const log = (opts.logger ?? noopLogger).withTag("uploads");
  const inflight = new Map<number, Promise<void>>();
  function download(row: StoredUpload): Promise<void> {
    const old = inflight.get(row.id);
    if (old) return old;
    if (row.state !== "queued" || !row.consent) return Promise.resolve();
    const work = (async () => {
      try {
        const result = await opts.source.load(row.group_id, JSON.parse(row.source));
        if (result.state === "stored") opts.store.save(row.group_id, row.id, result.data, result.mime);
        else opts.store.fail(row.group_id, row.id, result.state, result.state === "too_large" ? result.size : undefined);
      } catch {
        opts.store.fail(row.group_id, row.id, "failed");
        log.warn(`upload f${row.id} could not be saved`);
      }
    })().finally(() => inflight.delete(row.id));
    inflight.set(row.id, work);
    return work;
  }
  return {
    ingest(msg: GroupMessage) {
      if (msg.isSelf) return [];
      const ids = (msg.files ?? []).map((f, i) => opts.store.register(msg, f, i, opts.privacy).id);
      const command = /^同意上传\s+(f[1-9]\d{0,14})$/.exec(msg.text.trim());
      if (command) {
        const id = parseFileRef(command[1]!);
        if (opts.store.approve(msg.groupId, id, msg.userId)) ids.push(id);
      }
      for (const id of ids) { const row = opts.store.get(msg.groupId, id); if (row) void download(row); }
      return ids;
    },
    async capture(msg) {
      const ids = msg.fileIds ?? opts.store.ofMessage(msg).map((f) => f.id);
      const rows = ids.flatMap((id) => { const row = opts.store.get(msg.groupId, id); return row ? [row] : []; });
      await Promise.all(rows.map(download));
      return rows.map((r) => opts.store.get(msg.groupId, r.id)!);
    },
  };
}
