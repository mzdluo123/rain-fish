import type { Migration } from "../../types.js";
import { m0001 } from "./0001_messages.js";
import { m0002 } from "./0002_messages_fts.js";
import { m0003 } from "./0003_files.js";
import { m0004 } from "./0004_conversations.js";
import { m0005 } from "./0005_restart_state.js";
import { m0006 } from "./0006_speak_state.js";
import { m0007 } from "./0007_images.js";
import { m0008 } from "./0008_colab_runtime.js";
import { m0009 } from "./0009_colab_exec.js";

/** Append-only, in order. Never edit or renumber a migration that has shipped; add a new one. */
export const migrations: readonly Migration[] = [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009];
