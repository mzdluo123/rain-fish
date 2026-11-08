import { readFileSync } from "node:fs";
import { bootstrap } from "./bootstrap.js";
import { openDb } from "./db/open.js";
import { exportTree, importDir } from "./vfs-io.js";
import { VirtualFs } from "./vfs.js";

const USAGE = `Usage: bun run fs <command>
  ls [path]                 list a virtual directory (default /)
  cat <path>                print a virtual file
  put <path> <hostfile>     write a host file to a virtual path (overwrites)
  import <hostdir> [--force]  copy a host directory into / (existing files are kept unless --force)
  export <path> <hostdir>   copy a virtual file/tree out to the host disk
  rm <path> [-r]            delete a virtual file or directory`;

const [cmd, ...args] = process.argv.slice(2);
const { config, logger } = bootstrap();
const db = openDb(config.dbPath);
const vfs = new VirtualFs(db);

try {
  switch (cmd) {
    case "ls":
      for (const e of vfs.walk(args[0] ?? "/").filter((e) => e.path !== (args[0] ? VirtualFs.normalize(args[0]) : "")))
        process.stdout.write(`${e.kind === "dir" ? "d" : "-"} ${String(e.size).padStart(8)}  ${e.path}${e.kind === "dir" ? "/" : ""}\n`); // data, not a log line
      break;
    case "cat":
      process.stdout.write(vfs.readFile(need(args[0], "path")));
      break;
    case "put":
      vfs.writeFile(need(args[0], "path"), readFileSync(need(args[1], "hostfile")));
      logger.success(`wrote ${VirtualFs.normalize(args[0]!)}`);
      break;
    case "import": {
      const { written, skipped } = importDir(vfs, need(args[0], "hostdir"), { force: args.includes("--force") });
      logger.success(`imported ${written.length} file(s)`);
      if (skipped.length) logger.warn(`kept ${skipped.length} existing file(s) (use --force to overwrite): ${skipped.join(", ")}`);
      break;
    }
    case "export":
      logger.success(`exported ${exportTree(vfs, need(args[0], "path"), need(args[1], "hostdir")).length} file(s)`);
      break;
    case "rm":
      vfs.remove(need(args[0], "path"), args.includes("-r"));
      break;
    default:
      process.stdout.write(`${USAGE}\n`);
      process.exitCode = cmd ? 1 : 0;
  }
} catch (err) {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  db.close();
}

function need(v: string | undefined, name: string): string {
  if (!v) throw new Error(`missing <${name}>\n${USAGE}`);
  return v;
}
