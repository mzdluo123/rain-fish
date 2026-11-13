import path from "node:path";
import { VirtualFs } from "../vfs.js";

export const TRANSFER_MAX_FILES = 32;
export const TRANSFER_MAX_FILE_BYTES = 1024 * 1024;
export const TRANSFER_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

/** Remote paths are relative to this run's directory, never to the kernel or host filesystem. */
export function remoteFilePath(p: string): string {
  if (!p || p.includes("\0") || p.includes("\\") || path.posix.isAbsolute(p) || p.split("/").some((s) => !s || s === "." || s === "..")) {
    throw new Error(`EINVAL: sandbox path must be a relative file path without . or ..: '${p}'`);
  }
  VirtualFs.normalize(p);
  return p;
}

export function checkTransferSizes(sizes: readonly number[]): void {
  if (sizes.length > TRANSFER_MAX_FILES) throw new Error(`EFBIG: at most ${TRANSFER_MAX_FILES} files per transfer.`);
  if (sizes.some((s) => s > TRANSFER_MAX_FILE_BYTES) || sizes.reduce((a, b) => a + b, 0) > TRANSFER_MAX_TOTAL_BYTES) {
    throw new Error(`EFBIG: transfer limit is ${TRANSFER_MAX_FILE_BYTES} bytes per file and ${TRANSFER_MAX_TOTAL_BYTES} bytes in total.`);
  }
}
