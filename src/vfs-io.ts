import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { VirtualFs } from "./vfs.js";

/**
 * Copies a host directory into the virtual filesystem (at `/`, or under `dest`).
 * Existing virtual files are kept unless `force`, so re-importing never clobbers what the agent
 * has written since (e.g. its persona.md). Returns the virtual paths written / skipped.
 */
export function importDir(vfs: VirtualFs, hostDir: string, opts: { force?: boolean; dest?: string } = {}) {
  const written: string[] = [];
  const skipped: string[] = [];
  const dest = opts.dest ?? "/";
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const host = path.join(dir, name);
      const virtual = VirtualFs.normalize(path.posix.join(dest, path.relative(hostDir, host).split(path.sep).join("/")));
      if (statSync(host).isDirectory()) {
        vfs.mkdir(virtual);
        walk(host);
      } else if (vfs.exists(virtual) && !opts.force) {
        skipped.push(virtual);
      } else {
        vfs.writeFile(virtual, readFileSync(host));
        written.push(virtual);
      }
    }
  };
  walk(hostDir);
  return { written, skipped };
}

/** Copies a virtual file or directory tree out to the host disk. Returns the host paths written. */
export function exportTree(vfs: VirtualFs, virtualPath: string, hostDir: string): string[] {
  const root = VirtualFs.normalize(virtualPath);
  const out: string[] = [];
  for (const e of vfs.walk(root)) {
    const rel = e.path === root ? "" : e.path.slice(root === "/" ? 1 : root.length + 1);
    const host = path.join(hostDir, rel);
    if (e.kind === "dir") {
      mkdirSync(host, { recursive: true });
    } else {
      mkdirSync(path.dirname(host), { recursive: true });
      writeFileSync(host, vfs.readFile(e.path));
      out.push(host);
    }
  }
  return out;
}
