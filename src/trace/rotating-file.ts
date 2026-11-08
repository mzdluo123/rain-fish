import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RotationOptions {
  dir: string;
  /** Base name: the live file is `<name>.jsonl`, rotated ones `<name>.<YYYYMMDD-HHmmss>[-n].jsonl[.gz]`. */
  name: string;
  /** Rotate before a write that would take the live file past this size. */
  maxBytes: number;
  /** Keep at most this many rotated files (newest first). */
  maxFiles: number;
  /** Delete rotated files whose last write is older than this many days. */
  maxAgeDays: number;
  /** gzip rotated files. */
  compress: boolean;
  /** Replaceable in tests. */
  now?: () => Date;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/**
 * An append-only line file that rotates by size and by local calendar day, compresses what it rotates,
 * and prunes old files by count and age. Synchronous on purpose: lines are small, order is exact, and a
 * crash loses nothing that was returned from `write`. Rotation is a rename, so a reader tailing the live
 * file never sees a half-written line. `write` throws on I/O errors; the caller decides what that means.
 */
export class RotatingFile {
  readonly livePath: string;
  private size = 0;
  private day: string;
  private readonly rotatedPattern: RegExp;
  private readonly now: () => Date;

  constructor(private readonly o: RotationOptions) {
    this.now = o.now ?? (() => new Date());
    this.livePath = path.join(o.dir, `${o.name}.jsonl`);
    this.rotatedPattern = new RegExp(`^${o.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d{8}-\\d{6}(?:-\\d+)?\\.jsonl(?:\\.gz)?$`);
    mkdirSync(o.dir, { recursive: true });
    this.day = localDay(this.now());
    if (existsSync(this.livePath)) {
      const st = statSync(this.livePath);
      this.size = st.size;
      this.day = localDay(st.mtime); // a file last written on an earlier day is rotated by the first write of today
    }
    this.prune();
  }

  write(line: string): void {
    const bytes = Buffer.byteLength(line, "utf-8");
    const today = localDay(this.now());
    if (this.size > 0 && (today !== this.day || this.size + bytes > this.o.maxBytes)) this.rotate();
    if (this.size === 0) this.day = today;
    try {
      appendFileSync(this.livePath, line);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      mkdirSync(this.o.dir, { recursive: true }); // the directory was removed while running
      appendFileSync(this.livePath, line);
      this.size = 0;
    }
    this.size += bytes;
  }

  /** Rotated files, newest first, as absolute paths. */
  rotated(): string[] {
    return this.listRotated().map((f) => f.file);
  }

  private rotate(): void {
    if (!existsSync(this.livePath)) {
      this.size = 0; // removed behind our back: nothing to rotate
      return;
    }
    const at = this.now();
    let target = path.join(this.o.dir, `${this.o.name}.${stamp(at)}.jsonl`);
    for (let n = 1; existsSync(target) || existsSync(`${target}.gz`); n++) target = path.join(this.o.dir, `${this.o.name}.${stamp(at)}-${n}.jsonl`);
    renameSync(this.livePath, target);
    this.size = 0;
    this.day = localDay(at);
    if (this.o.compress) this.compress(target);
    this.prune();
  }

  /** Best effort: if compression fails the plain rotated file simply stays. The mtime is kept so age pruning still works. */
  private compress(file: string): void {
    try {
      const st = statSync(file);
      const gz = `${file}.gz`;
      const tmp = `${gz}.tmp`;
      writeFileSync(tmp, Bun.gzipSync(readFileSync(file)));
      utimesSync(tmp, st.atime, st.mtime);
      renameSync(tmp, gz);
      unlinkSync(file);
    } catch {
      // keep the uncompressed file
    }
  }

  private listRotated(): { file: string; mtime: number }[] {
    return readdirSync(this.o.dir)
      .filter((f) => this.rotatedPattern.test(f))
      .map((f) => {
        const file = path.join(this.o.dir, f);
        return { file, mtime: statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime || b.file.localeCompare(a.file));
  }

  private prune(): void {
    const cutoff = this.now().getTime() - this.o.maxAgeDays * 86_400_000;
    const files = this.listRotated();
    files.forEach((f, i) => {
      if (i >= this.o.maxFiles || f.mtime < cutoff) {
        try {
          unlinkSync(f.file);
        } catch {
          // already gone
        }
      }
    });
  }
}
