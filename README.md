# rain-fish

Pi-based QQ group bot (Yukino). The agent can list/search/read/write/edit files in a **virtual filesystem stored in SQLite** and search the group's message history; it cannot execute code. Everything (messages, files, schema version) lives in one SQLite file, `data/bot.db`.

```
bun install
bun start                     # CLI REPL with the agent
bun run bot                   # QQ bot (see below)
bun test                      # bun:test, no API key needed
bunx tsc                      # typecheck
```

Configuration: `cp .env.example .env` and edit. Bun loads `.env` automatically (no dotenv dependency); real environment variables override it, and `KEY=` with an empty value counts as unset. Every setting is validated at startup. `.env` is git-ignored, `.env.example` documents every variable.

Credentials/model come from Pi's usual config (`~/.pi/agent`, or provider env vars such as `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`).

## Model and context management
- `MODEL=provider/model-id` picks the model (empty = Pi's default). Unknown model: startup stops and lists some known ones; a model without credentials only warns, so message ingestion keeps working.
- Each group has one persistent agent conversation, stored in SQLite (`agent_messages`, `agent_archives`), so restarts resume it. A failed model call leaves no trace in it.
- **Level 1 - pruning.** Before every model call, tool results and tool-call arguments of at least `CONTEXT_PRUNE_MIN_TOKENS` that are older than the newest `CONTEXT_RECENT_TOKENS` are replaced by a one-line placeholder. It is a view: the stored history is complete, and the call/result pairing is preserved.
- **Level 2 - snap compaction.** When the estimated context passes `CONTEXT_COMPACT_TOKENS`, everything older than the recent window (cut at a turn boundary) is serialized and rendered into bitmap frames by [`@oh-my-pi/snapcompact`](https://www.npmjs.com/package/@oh-my-pi/snapcompact): local and deterministic, no LLM call. The frames replace the old messages; the archive text is what is persisted, and later compactions extend it within `CONTEXT_ARCHIVE_TOKENS` (oldest text falls off first). Models without image input get the same archive as plain text.
- Token counts are estimates (CJK-aware), not provider usage; compaction is checked before each new message, not in the middle of a tool loop.
- Pi's own LLM-summary compaction is switched off so the two never fight.

## Logging
[consola](https://github.com/unjs/consola): coloured badges/icons and timestamps on a terminal, one timestamped plain line per entry (`2026-11-08 21:06:48 WARN    [qq] ...`) when piped or redirected, errors/warnings on stderr. `LOG_LEVEL=silent|error|warn|info|debug` (debug logs every stored message and each agent tool call). No `console.*` calls are left in `src/`; the only raw stdout writes are the REPL's streamed model text and `bun run fs ls|cat` data output.

## State in one file
- `DB_PATH` (default `data/bot.db`). Back it up by copying the file (stop the bot first, or use SQLite's backup API; WAL mode adds `-wal`/`-shm` files while running).
- Schema is managed by a small forward-only migrator (`src/db/migrations/`, applied on open).
- **Filesystem**: table `files` (`src/vfs.ts`). Paths are absolute from `/`; `..` cannot leave the root; there is no host disk behind it, and it starts empty. Default quotas: 1 MiB per file, 64 MiB total.
- **System prompt**: the host file `prompts/agent.md` (`PROMPT_FILE`), used verbatim as the system prompt. It is not part of the agent's filesystem, so the agent cannot read or change it; edit it like any file in the repo (it is read when a group's conversation starts, so restart the bot to apply it everywhere). The agent's own evolving self-profile is `/persona.md` in its filesystem, which the prompt tells it to read at the start of a conversation.
- Manage files from the host: `bun run fs ls|cat|put|import|export|rm` (run `bun run fs` for usage). `import` keeps files that already exist unless `--force`, so re-seeding never clobbers what the agent wrote. A fresh database needs no seeding.

## How it is locked down
- `src/agent.ts`: tool allowlist `read, write, edit, ls, find, grep, search_messages, send`. Built-in `bash` is never enabled; extensions, skills, prompt templates and context files are off; startup aborts if any other tool is active. `send` only posts text to the conversation's own group through the bot.
- File tools are backed by `VirtualFs`, not the host disk. Pi's built-in `find`/`grep` (which shell out to `fd`/`rg`) are replaced by database-backed versions.
- Sessions are in memory only.

## QQ bot (NapCat / OneBot v11)
This program is a WebSocket **client**: point it at NapCat's WebSocket server and run

```
QQ_WS_URL=ws://127.0.0.1:3001 QQ_TOKEN=... QQ_GROUPS=123,456 bun run bot   # QQ_TOKEN / QQ_GROUPS optional
```

- Every group message is stored (SQLite FTS5, Chinese/Japanese segmented with `Intl.Segmenter`) and searchable by the agent through `search_messages`.
- **Wake-ups.** Messages do not each cost a model call. Per group, every message of a handled group (not just @-mentions) is queued; the agent is woken at the arrival times of a Poisson process, i.e. after an exponentially distributed wait with mean `WAKE_CHAT_MEAN_SECONDS` (started by the first queued message), and sees everything queued in one prompt. Once a queued message @-mentions the bot or replies to one of its messages, the faster `WAKE_ADDRESSED_MEAN_SECONDS` process also runs and the earlier wake-up wins; such messages are flagged `【对你说】` in the prompt. Runs of a group never overlap; messages arriving during a run wait for the next wake-up. If a run fails, its messages are dropped (still stored and searchable), not retried.
- **`send` tool.** The agent speaks only through `send(text, reply_to?)`; its plain output is not delivered. A successful `send` ends the run (`terminate`) until the next wake-up; long text is split, and `reply_to` quotes a message id (shown as `#id` in each prompt header). Not sending is how it stays silent. If the model calls other tools in the same step as `send`, the run continues after that step (Pi only stops when every tool call in a step asks to).
- One agent conversation per group, resumed from SQLite.
- Enable NapCat's `reportSelfMessage` (optional) so the bot's own messages are stored as well.
- All incoming frames are validated with Zod at the edge (`src/qq/`); invalid ones are logged and dropped. Environment config is validated at startup too.
- Without a model API key the bot still stores messages and logs a failed reply.
