import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createLogger, noopLogger } from "../src/logger.js";

const spies: { mockRestore(): void }[] = [];
afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  spies.push(
    spyOn(process.stdout, "write").mockImplementation(((s: string) => (out.push(String(s)), true)) as never),
    spyOn(process.stderr, "write").mockImplementation(((s: string) => (err.push(String(s)), true)) as never),
  );
  return { out, err };
}

describe("createLogger (plain output, used when piped)", () => {
  it("writes one timestamped line per entry with level and tag; errors/warnings go to stderr", () => {
    const { out, err } = capture();
    const log = createLogger("debug", { fancy: false }).withTag("qq");
    log.info("hello 你好");
    log.success("connected");
    log.warn("careful");
    log.error("boom");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} INFO {4}\[qq\] hello 你好\n$/);
    expect(out[1]).toMatch(/ SUCCESS \[qq\] connected\n$/);
    expect(err.map((l) => l.replace(/^\S+ \S+ /, ""))).toEqual(["WARN    [qq] careful\n", "ERROR   [qq] boom\n"]);
  });

  it("honours the level: nothing below it is written, 'silent' writes nothing at all", () => {
    const { out, err } = capture();
    const warn = createLogger("warn", { fancy: false });
    warn.debug("d");
    warn.info("i");
    warn.success("s");
    expect(out.length + err.length).toBe(0);
    warn.warn("w");
    expect(err).toHaveLength(1);
    const silent = createLogger("silent", { fancy: false });
    silent.error("e");
    expect(err).toHaveLength(1);
  });

  it("the fancy reporter actually emits output (a mis-set reporters option once silenced it)", () => {
    const { out, err } = capture();
    createLogger("info", { fancy: true }).info("visible");
    expect(out.join("") + err.join("")).toContain("visible");
  });
});

describe("noopLogger", () => {
  it("accepts every call, including child loggers, and prints nothing", () => {
    const { out, err } = capture();
    noopLogger.withTag("x").info("a");
    noopLogger.error("b");
    expect(out.length + err.length).toBe(0);
  });
});
