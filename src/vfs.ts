import type { Database } from "bun:sqlite";
import path from "node:path";
import type { FileEntry, FileStat, VfsLimits } from "./types.js";

/** Path limits: parent directories are stored as rows outside `maxTotalBytes`, so long/deep paths must be bounded. */
export const MAX_PATH_BYTES = 1024;
export const MAX_PATH_DEPTH = 32;
export const DEFAULT_VFS_LIMITS: VfsLimits = { maxFileBytes: 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };

/** Errors carry a POSIX-style `code`, like Node's fs errors, so tool messages read naturally. */
export class VfsError extends Error {
  constructor(
    readonly code: "ENOENT" | "EISDIR" | "ENOTDIR" | "ENOTEMPTY" | "EINVAL" | "EFBIG" | "ENOSPC" | "EBUSY",
    description: string,
    p: string,
  ) {
    super(`${code}: ${description}, '${p}'`);
    this.name = "VfsError";
  }
}

interface Row {
  path: string;
  kind: "file" | "dir";
  size: number;
  mtime: number;
}

/** Half-open key range covering every path strictly below `dir`: ["/a/", "/a0"). Avoids LIKE escaping. */
function subtreeRange(dir: string): [string, string] {
  const prefix = dir === "/" ? "/" : `${dir}/`;
  return [prefix, `${prefix.slice(0, -1)}0`]; // '0' is the character after '/'
}

/**
 * A POSIX-like filesystem stored in the `files` table. There is no host filesystem behind it, so there is
 * nothing to escape from: every path is resolved against "/" ("/../.." is "/"), and there are no symlinks.
 */
export class VirtualFs {
  constructor(
    private readonly db: Database,
    private readonly limits: VfsLimits = DEFAULT_VFS_LIMITS,
  ) {}

  /** Absolute normalised path. Relative paths resolve against "/". */
  static normalize(p: string): string {
    if (p.includes("\0")) throw new VfsError("EINVAL", "invalid path", p.replaceAll("\0", "\\0"));
    const n = path.posix.resolve("/", p);
    if (Buffer.byteLength(n) > MAX_PATH_BYTES) throw new VfsError("EINVAL", `path too long (> ${MAX_PATH_BYTES} bytes)`, `${n.slice(0, 64)}…`);
    if (n.split("/").length - 1 > MAX_PATH_DEPTH) throw new VfsError("EINVAL", `path too deep (> ${MAX_PATH_DEPTH} components)`, `${n.slice(0, 64)}…`);
    return n;
  }

  stat(p: string): FileStat | undefined {
    const n = VirtualFs.normalize(p);
    if (n === "/") return { kind: "dir", size: 0, mtime: 0 };
    const row = this.db.query("SELECT kind, size, mtime FROM files WHERE path = ?").get(n) as FileStat | null;
    return row ?? undefined;
  }

  exists(p: string): boolean {
    return this.stat(p) !== undefined;
  }

  readFile(p: string): Buffer {
    const n = VirtualFs.normalize(p);
    const st = this.stat(n);
    if (!st) throw new VfsError("ENOENT", "no such file or directory", n);
    if (st.kind === "dir") throw new VfsError("EISDIR", "illegal operation on a directory", n);
    const row = this.db.query("SELECT content FROM files WHERE path = ?").get(n) as { content: Uint8Array };
    return Buffer.from(row.content);
  }

  readText(p: string): string {
    return this.readFile(p).toString("utf-8");
  }

  /** Creates or overwrites a file; missing parent directories are created. */
  writeFile(p: string, data: string | Uint8Array): void {
    const n = VirtualFs.normalize(p);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
    if (n === "/") throw new VfsError("EISDIR", "illegal operation on a directory", n);
    if (bytes.byteLength > this.limits.maxFileBytes) {
      throw new VfsError("EFBIG", `file too large (${bytes.byteLength} > ${this.limits.maxFileBytes} bytes)`, n);
    }
    this.db.transaction(() => {
      const existing = this.stat(n);
      if (existing?.kind === "dir") throw new VfsError("EISDIR", "illegal operation on a directory", n);
      const sum = this.db.query("SELECT COALESCE(SUM(size), 0) AS t FROM files").get() as { t: number }; // aggregate always returns one row
      const total = sum.t;
      if (total - (existing?.size ?? 0) + bytes.byteLength > this.limits.maxTotalBytes) {
        throw new VfsError("ENOSPC", `filesystem full (limit ${this.limits.maxTotalBytes} bytes)`, n);
      }
      this.ensureDirs(path.posix.dirname(n));
      this.db
        .query(
          `INSERT INTO files (path, kind, content, size, mtime) VALUES (?, 'file', ?, ?, ?)
           ON CONFLICT (path) DO UPDATE SET content = excluded.content, size = excluded.size, mtime = excluded.mtime`,
        )
        .run(n, bytes, bytes.byteLength, now());
    }).immediate();
  }

  /** Creates a batch atomically, refusing existing paths (including changes made during a remote run). */
  createFiles(files: readonly { path: string; content: Uint8Array }[]): void {
    this.db.transaction(() => {
      for (const file of files) {
        if (this.exists(file.path)) throw new VfsError("EINVAL", "output already exists; choose a new path", file.path);
        this.writeFile(file.path, file.content);
      }
    }).immediate();
  }

  /** `mkdir -p`: existing directories are fine, a file in the way is ENOTDIR. */
  mkdir(p: string): void {
    const n = VirtualFs.normalize(p);
    this.db.transaction(() => this.ensureDirs(n)).immediate();
  }

  /** Names (not paths) of the direct children, sorted. */
  readdir(p: string): string[] {
    const n = VirtualFs.normalize(p);
    const st = this.stat(n);
    if (!st) throw new VfsError("ENOENT", "no such file or directory", n);
    if (st.kind !== "dir") throw new VfsError("ENOTDIR", "not a directory", n);
    const [lo, hi] = subtreeRange(n);
    const rows = this.db
      .query(
        `SELECT substr(path, ?) AS name FROM files
         WHERE path >= ? AND path < ? AND instr(substr(path, ?), '/') = 0
         ORDER BY path`,
      )
      .all(lo.length + 1, lo, hi, lo.length + 1) as { name: string }[];
    return rows.map((r) => r.name);
  }

  /** `p` itself (if it exists) followed by everything below it, in path order. */
  walk(p: string): FileEntry[] {
    const n = VirtualFs.normalize(p);
    const self = this.stat(n);
    if (!self) return [];
    const out: FileEntry[] = n === "/" ? [] : [{ path: n, ...self }];
    if (self.kind === "file") return out;
    const [lo, hi] = subtreeRange(n);
    out.push(...(this.db.query("SELECT path, kind, size, mtime FROM files WHERE path >= ? AND path < ? ORDER BY path").all(lo, hi) as Row[]));
    return out;
  }

  /** Deletes a file, or a directory (recursively only if asked). The root cannot be removed. */
  remove(p: string, recursive = false): void {
    const n = VirtualFs.normalize(p);
    if (n === "/") throw new VfsError("EBUSY", "cannot remove the root directory", n);
    this.db.transaction(() => {
      const st = this.stat(n);
      if (!st) throw new VfsError("ENOENT", "no such file or directory", n);
      if (st.kind === "dir") {
        const [lo, hi] = subtreeRange(n);
        if (!recursive && this.db.query("SELECT 1 FROM files WHERE path >= ? AND path < ? LIMIT 1").get(lo, hi)) {
          throw new VfsError("ENOTEMPTY", "directory not empty", n);
        }
        this.db.query("DELETE FROM files WHERE path >= ? AND path < ?").run(lo, hi);
      }
      this.db.query("DELETE FROM files WHERE path = ?").run(n);
    }).immediate();
  }

  /**
   * Files (not directories) below `base` matching `pattern`, as absolute paths in path order.
   * A pattern without "/" matches the file name at any depth (like `fd`); otherwise it is matched
   * against the path relative to `base`. `ignore` globs are matched against the relative path.
   */
  glob(pattern: string, base: string, opts: { ignore?: readonly string[]; limit?: number } = {}): string[] {
    const root = VirtualFs.normalize(base);
    const out: string[] = [];
    for (const e of this.walk(root)) {
      if (e.kind !== "file") continue;
      const rel = relativeTo(root, e.path);
      const target = pattern.includes("/") ? rel : path.posix.basename(rel);
      if (!path.posix.matchesGlob(target, pattern)) continue;
      if (opts.ignore?.some((g) => path.posix.matchesGlob(rel, g))) continue;
      out.push(e.path);
      if (opts.limit !== undefined && out.length >= Math.max(1, opts.limit)) break;
    }
    return out;
  }

  /** Must run inside a transaction. */
  private ensureDirs(dir: string): void {
    if (dir === "/") return;
    const missing: string[] = [];
    for (let cur = dir; cur !== "/"; cur = path.posix.dirname(cur)) {
      const st = this.stat(cur);
      if (st?.kind === "file") throw new VfsError("ENOTDIR", "not a directory", cur);
      if (!st) missing.push(cur);
    }
    const insert = this.db.query("INSERT INTO files (path, kind, content, size, mtime) VALUES (?, 'dir', NULL, 0, ?)");
    for (const d of missing) insert.run(d, now());
  }
}

const now = () => Math.floor(Date.now() / 1000);

/** `p` relative to the directory (or file) `root`; a file passed as root yields its own name. */
export function relativeTo(root: string, p: string): string {
  if (p === root) return path.posix.basename(p);
  return root === "/" ? p.slice(1) : p.slice(root.length + 1);
}
