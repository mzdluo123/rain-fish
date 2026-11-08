import type { Migration } from "../../types.js";
import { m0001 } from "./0001_messages.js";
import { m0002 } from "./0002_messages_fts.js";
import { m0003 } from "./0003_files.js";
import { m0004 } from "./0004_conversations.js";

/** Append-only, in order. Never edit or renumber a migration that has shipped; add a new one. */
export const migrations: readonly Migration[] = [m0001, m0002, m0003, m0004];
