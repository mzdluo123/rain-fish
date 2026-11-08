import { openDb } from "../src/db/open.js";
import { AGENT_FILE } from "../src/agent.js";
import { MessageStore } from "../src/store.js";
import { VirtualFs } from "../src/vfs.js";

/** A fresh in-memory database with the agent's filesystem (seeded with /agent.md) and message store. */
export function makeEnv(agentMd: string | null = "# Persona\nYou are TESTBOT.") {
  const db = openDb(":memory:");
  const fs = new VirtualFs(db);
  const store = new MessageStore(db);
  if (agentMd !== null) fs.writeFile(AGENT_FILE, agentMd);
  return { db, fs, store };
}
