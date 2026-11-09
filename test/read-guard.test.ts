import { beforeEach, describe, expect, it } from "bun:test";
import { createAgent } from "../src/agent.js";
import { lastSeen } from "../src/context/read-guard.js";
import { DEFAULT_RULES, renderWakeRules, WAKE_RULES_PATH } from "../src/wake-rules.js";
import { makeEnv, markSeen } from "./helpers.js";

type Session = Awaited<ReturnType<typeof createAgent>>["session"];
let env: ReturnType<typeof makeEnv>;
let session: Session;
let tools: Map<string, { execute: (id: string, args: never) => Promise<{ content: { type: string; text?: string }[] }> }>;
const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute("t", args as never);
const edit = (p: string, from = "alpha", to = "omega") => call("edit", { path: p, edits: [{ oldText: from, newText: to }] });

beforeEach(async () => {
  env = makeEnv();
  ({ session } = await createAgent(env));
  tools = new Map(session.agent.state.tools.map((t) => [t.name, t as never]));
  env.fs.writeFile("/n.md", "alpha beta");
});

describe("edit and overwriting write need the file in the context window", () => {
  it("is refused when the file was never read, and nothing changes", async () => {
    await expect(edit("/n.md")).rejects.toThrow(/have not read '\/n\.md'.*Call read/);
    expect(env.fs.readText("/n.md")).toBe("alpha beta");
  });

  it("works once the file was read in an earlier step, and again for further edits", async () => {
    markSeen(session, "/n.md");
    await edit("/n.md");
    expect(env.fs.readText("/n.md")).toBe("omega beta");
    markSeen(session, "/n.md", { name: "edit" });
    await edit("/n.md", "beta", "gamma");
    expect(env.fs.readText("/n.md")).toBe("omega gamma");
  });

  it("path spelling does not matter (relative, ./, double slashes)", async () => {
    markSeen(session, "n.md");
    await edit("//n.md");
    expect(env.fs.readText("/n.md")).toBe("omega beta");
  });

  it("a read of another file does not count", async () => {
    markSeen(session, "/other.md");
    await expect(edit("/n.md")).rejects.toThrow(/have not read/);
  });

  it("a write of the file counts as having seen it (the agent just put that text there)", async () => {
    markSeen(session, "/n.md", { name: "write" });
    await edit("/n.md");
    expect(env.fs.readText("/n.md")).toBe("omega beta");
  });

  it("a failed read, or a read of only a slice, does not count", async () => {
    markSeen(session, "/n.md", { isError: true });
    markSeen(session, "/n.md", { args: { offset: 1 } });
    markSeen(session, "/n.md", { args: { limit: 5 } });
    await expect(edit("/n.md")).rejects.toThrow(/have not read/);
  });

  it("a whole-file read whose offset/limit arrive as null (how models send an omitted optional) counts", async () => {
    markSeen(session, "/n.md", { args: { offset: null, limit: null } });
    await edit("/n.md");
    expect(env.fs.readText("/n.md")).toBe("omega beta");
  });

  it("is refused after the context was cut (compaction, rollback, restart): the old read is gone with the messages", async () => {
    markSeen(session, "/n.md");
    session.agent.state.messages = []; // what compaction leaves of the old turns is only the archive text
    await expect(edit("/n.md")).rejects.toThrow(/have not read/);
  });

  it("is refused when the file changed after the agent last saw it (another group, the host)", async () => {
    const readAt = Date.now() - 5_000;
    env.fs.writeFile("/n.md", "alpha beta"); // written now, i.e. after the read below
    markSeen(session, "/n.md", { timestamp: readAt });
    await expect(edit("/n.md")).rejects.toThrow(/ESTALE.*changed after you last saw it/);
    markSeen(session, "/n.md"); // read again
    await edit("/n.md");
    expect(env.fs.readText("/n.md")).toBe("omega beta");
  });

  it("a missing file or a non-Markdown file reports its own error first", async () => {
    await expect(edit("/nope.md")).rejects.toThrow(/ENOENT/);
    env.fs.writeFile("/x.txt", "alpha");
    await expect(edit("/x.txt")).rejects.toThrow(/only Markdown/);
  });

  it("covers every file the agent may write: .md (the profile included) and the wake rules", async () => {
    env.fs.writeFile(WAKE_RULES_PATH, renderWakeRules(DEFAULT_RULES));
    await expect(edit(WAKE_RULES_PATH, "weight: 0.8", "weight: 0.4")).rejects.toThrow(/have not read/);
    env.fs.writeFile("/persona.md", "alpha");
    await expect(edit("/persona.md")).rejects.toThrow(/have not read/);
  });

  it("creating a new file needs no read", async () => {
    await call("write", { path: "/new.md", content: "x" });
    await call("write", { path: "/deep/er/new.md", content: "y" });
    expect(env.fs.readText("/new.md")).toBe("x");
  });
});

describe("lastSeen", () => {
  it("is the newest successful whole-file access among the messages", () => {
    const s = { agent: { state: { messages: [] as unknown[] } } };
    markSeen(s, "/a.md", { timestamp: 100 });
    markSeen(s, "/a.md", { name: "edit", timestamp: 300 });
    markSeen(s, "/a.md", { timestamp: 200 });
    markSeen(s, "/a.md", { isError: true, timestamp: 900 });
    markSeen(s, "/b.md", { timestamp: 500 });
    expect(lastSeen(s.agent.state.messages as never, "/a.md")).toBe(300);
    expect(lastSeen(s.agent.state.messages as never, "b.md")).toBe(500);
    expect(lastSeen(s.agent.state.messages as never, "/c.md")).toBeUndefined();
  });
});

describe("write over an existing file", () => {
  const overwrite = (p: string, content = "fresh") => call("write", { path: p, content });

  it("is refused when the file was not read, and nothing changes", async () => {
    await expect(overwrite("/n.md")).rejects.toThrow(/have not read '\/n\.md'/);
    expect(env.fs.readText("/n.md")).toBe("alpha beta");
  });

  it("works after a read, and after the agent's own write (it knows what it put there)", async () => {
    markSeen(session, "/n.md");
    await overwrite("/n.md", "one");
    markSeen(session, "/n.md", { name: "write" });
    await overwrite("/n.md", "two");
    expect(env.fs.readText("/n.md")).toBe("two");
  });

  it("follows the same rules as edit: cut context, a slice, a changed file", async () => {
    markSeen(session, "/n.md", { args: { limit: 3 } });
    await expect(overwrite("/n.md")).rejects.toThrow(/have not read/);
    markSeen(session, "/n.md", { timestamp: Date.now() - 5_000 });
    env.fs.writeFile("/n.md", "changed elsewhere");
    await expect(overwrite("/n.md")).rejects.toThrow(/ESTALE/);
    session.agent.state.messages = [];
    await expect(overwrite("/n.md")).rejects.toThrow(/have not read/);
    expect(env.fs.readText("/n.md")).toBe("changed elsewhere");
  });

  it("the profile and the wake rules too; a non-Markdown path reports its own error first", async () => {
    env.fs.writeFile("/persona.md", "old self");
    await expect(overwrite("/persona.md")).rejects.toThrow(/have not read/);
    env.fs.writeFile("/x.txt", "a");
    await expect(overwrite("/x.txt")).rejects.toThrow(/only Markdown/);
  });

  it("the content rules still apply after the read (broken wake rules are refused)", async () => {
    env.fs.writeFile(WAKE_RULES_PATH, renderWakeRules(DEFAULT_RULES));
    markSeen(session, WAKE_RULES_PATH);
    await expect(overwrite(WAKE_RULES_PATH, "rules: [")).rejects.toThrow(/was not changed/);
  });
});
