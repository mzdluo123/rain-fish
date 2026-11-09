import type { VfsOperations } from "./types.js";
import { VirtualFs } from "./vfs.js";
import { validateWakeRulesWrite, WAKE_RULES_PATH } from "./wake-rules.js";

/** Largest Markdown file the agent may create or modify (10 KiB). Bigger notes must be split into linked files. */
export const AGENT_MAX_FILE_BYTES = 10 * 1024;

/**
 * What the agent may write: Markdown files only, each at most `AGENT_MAX_FILE_BYTES`. The error text is
 * the agent's only instruction when it hits the size limit, so it spells out how to reorganise.
 */
function assertMarkdownPath(n: string): void {
  if (!/\.md$/i.test(n)) {
    throw new Error(`EINVAL: only Markdown files can be created or modified, and '${n}' is not a .md file. Use a file name ending in .md.`);
  }
}

export function assertAgentWritable(p: string, content: string | Uint8Array): void {
  const n = VirtualFs.normalize(p);
  assertMarkdownPath(n);
  if (n === WAKE_RULES_PATH) validateWakeRulesWrite(content); // a table that does not parse is never written
  const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf-8") : content.byteLength;
  if (bytes > AGENT_MAX_FILE_BYTES) {
    throw new Error(
      `EFBIG: '${n}' would be ${bytes} bytes, over the ${AGENT_MAX_FILE_BYTES}-byte (10 KB) limit for one file. Nothing was written. ` +
        `Do not shorten or summarise the content. Instead create new .md files (group them in directories by topic), move parts of the content into them word for word so no information is lost, ` +
        `and link every new file from the file it came from with a Markdown link such as [topic](/notes/topic.md). ` +
        `Keep the result a tree organised by meaning: an index file links to topic files, which may link to finer ones. Then write again, each file within the limit.`,
    );
  }
}

/**
 * Pi tool backends (read / write / edit / ls) on top of the virtual filesystem. `requireSeen` runs first for every `edit` and for every `write` that would overwrite an existing
 * file (not for creating one), and may throw to refuse it; the agent wires it to "the file must be in the context window" (`assertSeen`).
 */
export function createVfsOperations(vfs: VirtualFs, opts: { requireSeen?: (p: string) => void } = {}): VfsOperations {
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
      writeFile: async (p, content) => {
        const n = VirtualFs.normalize(p);
        assertMarkdownPath(n);
        if (vfs.stat(n)?.kind === "file") opts.requireSeen?.(n); // overwriting needs the current text in view; creating a file does not
        assertAgentWritable(p, content);
        vfs.writeFile(p, content);
      },
      mkdir: async (dir) => vfs.mkdir(dir),
    },
    edit: {
      readFile: async (p) => vfs.readFile(p),
      writeFile: async (p, content) => (assertAgentWritable(p, content), vfs.writeFile(p, content)),
      access: async (p) => (requireExists(p), assertMarkdownPath(VirtualFs.normalize(p)), opts.requireSeen?.(p)),
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
