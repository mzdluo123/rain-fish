import { noopLogger } from "./logger.js";
import type { ImageStore } from "./image-store.js";
import type { GroupMessage, ImageSource, Logger, ModelImageFn, PictureArchive, StoredPicture } from "./types.js";

export interface PictureArchiveOptions {
  source: ImageSource;
  store: ImageStore;
  /** Total bytes kept; the least recently used pictures are deleted beyond it. A picture bigger than this is not kept. */
  maxBytes: number;
  /** Makes the copy the model sees (scaled down), when `image()` is asked for it. The stored original is never changed. Omit to hand the model the original. */
  shrink?: ModelImageFn;
  logger?: Logger;
}

/**
 * Keeps the pictures of group messages: `capture` downloads them (through the same guarded `ImageSource` the agent's
 * prompt uses: QQ hosts only, size cap, sniffed type), stores them and evicts the oldest-used ones past `maxBytes`.
 * Scaling for the model is not done here but in `image()`, only for the pictures that are really attached to a turn.
 * One download per message however often it is asked for; a message whose pictures could not be had is retried only if asked again after a restart.
 */
export function createPictureArchive(opts: PictureArchiveOptions): PictureArchive {
  const log = (opts.logger ?? noopLogger).withTag("pictures");
  const inflight = new Map<string, Promise<(StoredPicture | undefined)[]>>();

  async function run(msg: GroupMessage): Promise<(StoredPicture | undefined)[]> {
    const refs = msg.images ?? [];
    const out = await Promise.all(
      refs.map(async (ref, idx): Promise<StoredPicture | undefined> => {
        try {
          // Already stored (an earlier wake-up, or a restart): nothing to download, the URL may be gone.
          const had = opts.store.slot(msg.groupId, msg.messageId, idx);
          if (had) return { id: had.id };
          const image = await opts.source.load(ref.url);
          if (!image) return undefined;
          const bytes = Buffer.from(image.data, "base64");
          if (bytes.length > opts.maxBytes) return undefined;
          return { id: opts.store.put(msg.groupId, msg.messageId, idx, bytes, image.mimeType) };
        } catch (err) {
          log.warn(`could not store a picture of message ${msg.messageId}: ${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        }
      }),
    );
    try {
      const evicted = opts.store.evict(opts.maxBytes);
      if (evicted > 0) log.info(`deleted ${evicted} least recently used picture(s) to stay under ${opts.maxBytes} bytes`);
    } catch (err) {
      log.warn(`picture eviction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    log.debug(`group ${msg.groupId}: stored ${out.filter(Boolean).length}/${refs.length} picture(s) of message ${msg.messageId}`);
    return out;
  }

  return {
    async image(groupId, id) {
      try {
        const img = opts.store.get(groupId, id);
        if (!img) return undefined;
        const shown = opts.shrink ? await opts.shrink({ data: img.data, mime: img.mime }) : { data: img.data, mime: img.mime };
        return { type: "image", data: shown.data.toString("base64"), mimeType: shown.mime };
      } catch (err) {
        log.warn(`could not prepare picture i${id}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    },
    capture(msg) {
      if (!msg.images?.length) return Promise.resolve([]);
      const key = `${msg.groupId}/${msg.messageId}`;
      let p = inflight.get(key);
      if (!p) {
        p = run(msg);
        inflight.set(key, p);
        // Keep the result for later callers only while it is cheap (a second wake-up on the same message asks again, reads the stored copy).
        p.finally(() => setTimeout(() => inflight.delete(key), 60_000).unref?.()).catch(() => {});
      }
      return p;
    },
  };
}
