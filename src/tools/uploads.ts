import path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { checkTransferSizes, remoteFilePath } from "../colab/files.js";
import { fileRef, parseFileRef, uploadSummary, type UploadStore } from "../upload-store.js";
import type { VirtualFs } from "../vfs.js";
import { escapeText } from "../xml.js";

export const LIST_UPLOADS_TOOL = "list_uploads";
export const FETCH_FILE_TOOL = "fetch_file_to_sandbox";

function time(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("Invalid date; use ISO 8601.");
  return Math.floor(ms / 1000);
}

/** Explicit mapping only: remote sandboxes are fresh per run, so no hidden staging state is kept. */
export function uploadInput(store: UploadStore, fs: VirtualFs, groupId: string, id: string, sandboxPath?: string) {
  const row = store.get(groupId, parseFileRef(id));
  if (!row) throw new Error("No such file in this group.");
  const content = fs.readFile(row.path); // the scoped VFS also explains pending / oversized / failed receipts
  checkTransferSizes([content.byteLength]);
  if (row.state !== "stored") throw new Error("File is not approved and stored.");
  return { vfs_path: row.path, sandbox_path: remoteFilePath(sandboxPath ?? `${fileRef(row.id)}__${path.posix.basename(row.name)}`) };
}

export function createListUploadsTool(store: UploadStore, groupId: string) {
  return defineTool({
    name: LIST_UPLOADS_TOOL,
    label: "List uploads",
    description: "List this group's uploaded files, paths, sizes, SHA-256 and states. Metadata-only files cannot be read until their uploader consents; oversized files have no saved bytes.",
    promptSnippet: "Find uploaded files in this group",
    parameters: Type.Object({
      uploader: Type.Optional(Type.String({ description: "Uploader's user id" })),
      since: Type.Optional(Type.String({ description: "Earliest time, ISO 8601" })),
      until: Type.Optional(Type.String({ description: "Latest time, ISO 8601" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    execute: async (_id, p) => {
      const rows = store.list(groupId, { uploader: p.uploader, since: time(p.since), until: time(p.until), limit: p.limit });
      const text = rows.map((r) => escapeText(`${uploadSummary(r)} uploader=${r.uploader_id} time=${new Date(r.created_at * 1000).toISOString()} sha256=${r.sha256 ?? "unknown"}`)).join("\n");
      return { content: [{ type: "text", text: text || "No uploads." }], details: { count: rows.length } };
    },
  });
}

export function createFetchFileTool(store: UploadStore, fs: VirtualFs, groupId: string) {
  return defineTool({
    name: FETCH_FILE_TOOL,
    label: "Prepare sandbox file",
    description: "Prepare a stored upload for a future run_python call. Returns an input_files mapping; pass it to that call. No sandbox exists until run_python starts. Alternatively pass upload_ids directly to run_python for automatic mappings. No download, extraction or code execution happens here.",
    promptSnippet: "Prepare an uploaded file for run_python",
    parameters: Type.Object({ file_id: Type.String({ description: "Local upload id, e.g. f12" }), sandbox_path: Type.Optional(Type.String({ description: "Relative sandbox path; default f12__name" })) }),
    execute: async (_id, p) => {
      const input = uploadInput(store, fs, groupId, p.file_id, p.sandbox_path);
      return { content: [{ type: "text", text: escapeText(JSON.stringify({ input_files: [input] })) }], details: { input_files: [input] } };
    },
  });
}
