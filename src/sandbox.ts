import { mkdirSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type {
  EditOperations,
  FindOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@mariozechner/pi-coding-agent";

/**
 * Filesystem jail. Every path handed to a tool is canonicalised (symlinks
 * resolved) and rejected unless it lies inside `root`.
 */
export class Sandbox {
  /** Canonical absolute root directory. */
  readonly root: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.root = realpathSync(dir);
  }

  /** Canonicalise `p`; works for paths that do not exist yet. */
  private async canonical(p: string): Promise<string> {
    try {
      return await fs.realpath(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    // ENOENT: either truly missing, or a dangling symlink (which write would follow).
    const st = await fs.lstat(p).catch(() => undefined);
    if (st) throw new Error(`Access denied: dangling symlink: ${p}`);
    const parent = path.dirname(p);
    if (parent === p) throw new Error(`Access denied: cannot resolve ${p}`);
    return path.join(await this.canonical(parent), path.basename(p));
  }

  /** Returns the canonical path, or throws if it escapes the sandbox. */
  async resolve(p: string): Promise<string> {
    const abs = path.resolve(this.root, p);
    const real = await this.canonical(abs);
    const rel = path.relative(this.root, real);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`Access denied: path is outside the sandbox: ${p}`);
    }
    return real;
  }
}

export interface SandboxOperations {
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
  ls: LsOperations;
  find: FindOperations;
  grep: GrepOperations;
}

export function createSandboxOperations(sb: Sandbox): SandboxOperations {
  return {
    read: {
      readFile: async (p) => fs.readFile(await sb.resolve(p)),
      access: async (p) => fs.access(await sb.resolve(p), fs.constants.R_OK),
      // Image sniffing disabled: images are not returned inline.
      detectImageMimeType: async () => null,
    },
    write: {
      writeFile: async (p, content) => fs.writeFile(await sb.resolve(p), content, "utf-8"),
      mkdir: async (dir) => {
        await fs.mkdir(await sb.resolve(dir), { recursive: true });
      },
    },
    edit: {
      readFile: async (p) => fs.readFile(await sb.resolve(p)),
      writeFile: async (p, content) => fs.writeFile(await sb.resolve(p), content, "utf-8"),
      access: async (p) => fs.access(await sb.resolve(p), fs.constants.R_OK | fs.constants.W_OK),
    },
    ls: {
      exists: async (p) => {
        const real = await sb.resolve(p);
        return fs.access(real).then(
          () => true,
          () => false,
        );
      },
      stat: async (p) => fs.stat(await sb.resolve(p)),
      readdir: async (p) => fs.readdir(await sb.resolve(p)),
    },
    find: {
      exists: async (p) => {
        const real = await sb.resolve(p);
        return fs.access(real).then(
          () => true,
          () => false,
        );
      },
      glob: async (pattern, cwd, { ignore, limit }) => {
        const base = await sb.resolve(cwd);
        const out: string[] = [];
        for await (const entry of fs.glob(pattern, { cwd: base })) {
          const rel = entry.split(path.sep).join("/");
          if (ignore.some((g) => path.posix.matchesGlob(rel, g))) continue;
          out.push(path.join(base, entry));
          if (out.length >= limit) break;
        }
        return out;
      },
    },
    grep: {
      // grep validates the search root through this call before spawning ripgrep.
      // ripgrep does not follow symlinks by default, so it cannot leave the root.
      isDirectory: async (p) => (await fs.stat(await sb.resolve(p))).isDirectory(),
      readFile: async (p) => fs.readFile(await sb.resolve(p), "utf-8"),
    },
  };
}
