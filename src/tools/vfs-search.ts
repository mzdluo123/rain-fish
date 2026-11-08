import { defineTool, DEFAULT_MAX_BYTES, formatSize } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { relativeTo, VirtualFs } from "../vfs.js";

const FIND_DEFAULT_LIMIT = 1000;
const GREP_DEFAULT_LIMIT = 100;
/** Lines longer than this are cut before matching and display (bounds regex work per line). */
const MAX_LINE_CHARS = 500;
const IGNORE = ["**/node_modules/**", "**/.git/**"];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isBinary = (b: Buffer) => b.subarray(0, 8192).includes(0);

function capOutput(text: string): string {
  if (text.length <= DEFAULT_MAX_BYTES) return text;
  return `${text.slice(0, DEFAULT_MAX_BYTES)}\n\n[${formatSize(DEFAULT_MAX_BYTES)} limit reached]`;
}

/** Same name and parameters as Pi's built-in `find`, but over the virtual filesystem. */
export function createVfsFindTool(vfs: VirtualFs) {
  return defineTool({
    name: "find",
    label: "find",
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Output is truncated to ${FIND_DEFAULT_LIMIT} results.`,
    promptSnippet: "Find files by glob pattern",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern, e.g. '*.md' (any depth) or 'notes/**/*.txt'" }),
      path: Type.Optional(Type.String({ description: "Directory to search (default: /)" })),
      limit: Type.Optional(Type.Number({ description: `Maximum number of results (default: ${FIND_DEFAULT_LIMIT})` })),
    }),
    execute: async (_id, p) => {
      const base = VirtualFs.normalize(p.path ?? "/");
      if (!vfs.exists(base)) throw new Error(`Path not found: ${base}`);
      const limit = p.limit ?? FIND_DEFAULT_LIMIT;
      const found = vfs.glob(p.pattern, base, { ignore: IGNORE, limit }).map((f) => relativeTo(base, f));
      if (found.length === 0) return { content: [{ type: "text", text: "No files found matching pattern" }], details: { count: 0 } };
      const notice = found.length >= limit ? `\n\n[${limit} results limit reached]` : "";
      return { content: [{ type: "text", text: capOutput(found.join("\n")) + notice }], details: { count: found.length } };
    },
  });
}

/** Same name and parameters as Pi's built-in `grep`, but searching file contents stored in the database. */
export function createVfsGrepTool(vfs: VirtualFs) {
  return defineTool({
    name: "grep",
    label: "grep",
    description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Output is truncated to ${GREP_DEFAULT_LIMIT} matches or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Search file contents for a regex or literal string",
    parameters: Type.Object({
      pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
      path: Type.Optional(Type.String({ description: "Directory or file to search (default: /)" })),
      glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.md' or 'notes/**/*.txt'" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
      context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
      limit: Type.Optional(Type.Number({ description: `Maximum number of matches to return (default: ${GREP_DEFAULT_LIMIT})` })),
    }),
    execute: async (_id, p) => {
      const base = VirtualFs.normalize(p.path ?? "/");
      if (!vfs.exists(base)) throw new Error(`Path not found: ${base}`);
      let re: RegExp;
      try {
        re = new RegExp(p.literal ? escapeRegExp(p.pattern) : p.pattern, p.ignoreCase ? "i" : "");
      } catch (err) {
        throw new Error(`Invalid regex: ${err instanceof Error ? err.message : String(err)}`);
      }
      const limit = p.limit ?? GREP_DEFAULT_LIMIT;
      const ctx = Math.max(0, Math.trunc(p.context ?? 0));
      const globMatches = new Set(p.glob ? vfs.glob(p.glob, base) : []);

      const out: string[] = [];
      let matches = 0;
      let limitReached = false;
      for (const entry of vfs.walk(base)) {
        if (entry.kind !== "file" || (p.glob && !globMatches.has(entry.path))) continue;
        const bytes = vfs.readFile(entry.path);
        if (isBinary(bytes)) continue;
        const lines = bytes.toString("utf-8").split(/\r?\n/);
        const shown = relativeTo(base, entry.path);
        let lastPrinted = -1;
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i]!.slice(0, MAX_LINE_CHARS))) continue;
          if (matches >= limit) {
            limitReached = true;
            break;
          }
          matches++;
          for (let j = Math.max(i - ctx, lastPrinted + 1); j <= Math.min(i + ctx, lines.length - 1); j++) {
            const text = lines[j]!.slice(0, MAX_LINE_CHARS);
            out.push(`${shown}${j === i ? ":" : "-"}${j + 1}${j === i ? ":" : "-"} ${text}`);
            lastPrinted = j;
          }
        }
        if (limitReached) break;
      }
      if (matches === 0) return { content: [{ type: "text", text: "No matches found" }], details: { count: 0 } };
      const notice = limitReached ? `\n\n[${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern]` : "";
      return { content: [{ type: "text", text: capOutput(out.join("\n")) + notice }], details: { count: matches } };
    },
  });
}
