import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_FILE } from "../src/agent.js";

/** Temp dir with `box/` (the sandbox, containing agent.md) and `secret.txt` outside it. */
export function makeBox(agentMd: string | null = "# Persona\nYou are TESTBOT.") {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sbx-"));
  const box = path.join(tmp, "box");
  const outside = path.join(tmp, "secret.txt");
  mkdirSync(box);
  writeFileSync(outside, "TOP-SECRET");
  if (agentMd !== null) writeFileSync(path.join(box, AGENT_FILE), agentMd);
  return { tmp, box, outside };
}
