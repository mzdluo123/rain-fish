# rain-fish

Pi-based QQ group bot (Yukino). The agent can list/search/read/write/edit files in a **virtual filesystem stored in SQLite** and search the group's message history; it cannot execute code. Everything (messages, files, schema version) lives in one SQLite file, `data/bot.db`.

```
bun install
bun run fs import workspace   # first run: seed /agent.md (the system prompt) into the database
bun start                     # CLI REPL with the agent
bun run bot                   # QQ bot (see below)
bun test                      # bun:test, no API key needed
bunx tsc                      # typecheck
```

Credentials/model come from Pi's usual config (`~/.pi/agent`, or provider env vars such as `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`).

## State in one file
- `DB_PATH` (default `data/bot.db`). Back it up by copying the file (stop the bot first, or use SQLite's backup API; WAL mode adds `-wal`/`-shm` files while running).
- Schema is managed by a small forward-only migrator (`src/db/migrations/`, applied on open).
- **Filesystem**: table `files` (`src/vfs.ts`). Paths are absolute from `/`; `..` cannot leave the root; there is no host disk behind it. Default quotas: 1 MiB per file, 64 MiB total.
- **System prompt**: `/agent.md` in that filesystem. The repo's `workspace/agent.md` is only the seed; edit it, then `bun run fs put /agent.md workspace/agent.md`. The agent can edit `/agent.md` itself (effective next session). Its own evolving self-profile is `/persona.md`, which `agent.md` tells it to read at the start of a conversation.
- Manage files from the host: `bun run fs ls|cat|put|import|export|rm` (run `bun run fs` for usage). `import` keeps files that already exist unless `--force`, so re-seeding never clobbers what the agent wrote.

## How it is locked down
- `src/agent.ts`: tool allowlist `read, write, edit, ls, find, grep, search_messages`. Built-in `bash` is never enabled; extensions, skills, prompt templates and context files are off; startup aborts if any other tool is active.
- File tools are backed by `VirtualFs`, not the host disk. Pi's built-in `find`/`grep` (which shell out to `fd`/`rg`) are replaced by database-backed versions.
- Sessions are in memory only.

## QQ bot (NapCat / OneBot v11)
This program is a WebSocket **client**: point it at NapCat's WebSocket server and run

```
QQ_WS_URL=ws://127.0.0.1:3001 QQ_TOKEN=... QQ_GROUPS=123,456 bun run bot   # QQ_TOKEN / QQ_GROUPS optional
```

- Every group message is stored (SQLite FTS5, Chinese/Japanese segmented with `Intl.Segmenter`) and searchable by the agent through `search_messages`.
- The bot answers when it is @-mentioned or when someone replies to one of its messages. One agent conversation per group (in memory); the reply quotes the triggering message and is split if long.
- Enable NapCat's `reportSelfMessage` (optional) so the bot's own messages are stored as well.
- All incoming frames are validated with Zod at the edge (`src/qq/`); invalid ones are logged and dropped. Environment config is validated at startup too.
- Without a model API key the bot still stores messages and logs a failed reply.
