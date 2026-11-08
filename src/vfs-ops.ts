import type { VfsOperations } from "./types.js";
import { VirtualFs } from "./vfs.js";

/** Pi tool backends (read / write / edit / ls) on top of the virtual filesystem. */
export function createVfsOperations(vfs: VirtualFs): VfsOperations {
  const requireExists = (p: string) => {
    if (!vfs.exists(p)) throw new Error(`ENOENT: no such file or directory, '${VirtualFs.normalize(p)}'`);
  };
  return {
    read: {
      readFile: async (p) => vfs.readFile(p),
      access: async (p) => requireExists(p),
      detectImageMimeType: async () => null, // images are not returned inline
    },
    write: {
      writeFile: async (p, content) => vfs.writeFile(p, content),
      mkdir: async (dir) => vfs.mkdir(dir),
    },
    edit: {
      readFile: async (p) => vfs.readFile(p),
      writeFile: async (p, content) => vfs.writeFile(p, content),
      access: async (p) => requireExists(p),
    },
    ls: {
      exists: (p) => vfs.exists(p),
      stat: (p) => {
        const st = vfs.stat(p);
        if (!st) throw new Error(`ENOENT: no such file or directory, '${VirtualFs.normalize(p)}'`);
        return { isDirectory: () => st.kind === "dir" };
      },
      readdir: (p) => vfs.readdir(p),
    },
  };
}
