# rain-fish

Pi-based QQ group bot (Yukino). The agent can list/search/read/write/edit files in a **virtual filesystem stored in SQLite** and search the group's message history; it never executes code on this host (the one exception, `run_python`, sends a `.py` file of its filesystem to a Google Colab runtime, only if `COLAB_ENABLED`). Everything (messages, files, schema version) lives in one SQLite file, `data/bot.db`.

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
- **Snap compaction** (the only way the history shrinks). When the estimated context passes `CONTEXT_COMPACT_TOKENS`, everything older than the recent window (cut at a turn boundary) is serialized and rendered into bitmap frames by [`@oh-my-pi/snapcompact`](https://www.npmjs.com/package/@oh-my-pi/snapcompact): local and deterministic, no LLM call. The frames replace the old messages; the archive text is what is persisted, and later compactions extend it within `CONTEXT_ARCHIVE_TOKENS` (oldest text falls off first). Models without image input get the same archive as plain text.
- Token counts are estimates (CJK-aware), not provider usage; compaction is checked before each new message, not in the middle of a tool loop.
- Pi's own LLM-summary compaction is switched off so the two never fight.
- **Compaction after the prompt cache expired** (`CACHE_COMPACT_*`). If more than `CACHE_COMPACT_TTL_SECONDS` passed since a group's last model request, the next request re-writes the whole prefix anyway, so the run starts by snap-compacting the WHOLE live context, but only if that saves at least `CACHE_COMPACT_MIN_SAVED_TOKENS` and `CACHE_COMPACT_MIN_SAVED_RATIO`. If it would save too little, `CACHE_COMPACT_CLEAR_FALLBACK` (on by default) forgets the whole context instead, archive included (chat log, files and `/persona.md` stay; this is not lossless). This runs before the run decides which pictures are already in the context, so a picture whose earlier copy was compacted away is attached again.
- **Memory flush.** Once the context passes `CONTEXT_FLUSH_RATIO` × `CONTEXT_COMPACT_TOKENS` (default 0.85), the agent gets one extra turn, before compaction retires older history, to save what matters into its `.md` files. `send` and `send_image` stay declared (changing the tool list would break the prompt cache) but are muted for that turn: they answer with a tool error and post nothing. It runs once per compaction cycle; if the turn fails it is logged, rolled back, retried on the next message, and compaction is not held up.
- **Agent files.** The agent can only create or modify `.md` notes, `.py` scripts (for `run_python`) and its `/wake-rules.yaml`, at most 10 KB each (`src/vfs-ops.ts`). Paths are capped at 1024 bytes and 32 components. An oversized write is rejected with an error telling it to split the content into new files without summarising, link them with Markdown links, and keep the memory a tree organised by meaning (entry point `/persona.md`). An `edit`, or a `write` over an existing file, is refused unless the file's current text is in the agent's context window (`src/context/read-guard.ts`): it must have `read` (or written) the file in an earlier step, a read cut by compaction/rollback/restart no longer counts, and a file changed by someone else since is refused as stale; the error tells it to read again. Creating a new file needs no read. Existing other files (e.g. imported from the host) stay readable. `bun run fs` is not subject to this.
- **Prompt framing.** Everything the agent reads in a user turn is XML-tagged: program text (flush request, archive framing) is `<system>…</system>`, group messages are `<message time id sender user_id [addressed]>…</message>`. Nicknames and message text are escaped (`& < >`, plus `"` in attributes), also in `search_messages` results, so a member cannot forge a `<system>` block or close a `<message>`. The system prompt file itself is not wrapped.

## Logging
[consola](https://github.com/unjs/consola): coloured badges/icons and timestamps on a terminal, one timestamped plain line per entry (`2026-11-08 21:06:48 WARN    [qq] ...`) when piped or redirected, errors/warnings on stderr. `LOG_LEVEL=silent|error|warn|info|debug` (debug logs every stored message and each agent tool call). No `console.*` calls are left in `src/`; the only raw stdout writes are the REPL's streamed model text and `bun run fs ls|cat` data output.

## Observability: the event log
Next to the human-readable log there is a machine-readable **event log**: one JSON object per line in `data/logs/agent.jsonl` (`TRACE_*` in `.env.example`; `TRACE_ENABLED=false` turns it off). It records what the agent did and how each group moves between states, so a run can be replayed, costs and latency measured, and failures traced. It is separate from the SQLite state (logs are not state), and `data/` is git-ignored.

**Record shape.** `{ v, t, seq, boot, ev, ...fields }`: schema version, UTC time, a per-process counter (a gap means lost events), the process run id (`boot`), the event name, and its fields. Correlation keys: `group`, `run` (one wake-up of one group), `turn` (one prompt to the model within it; `kind` is `message` or `flush`), `call_id` (one tool call). Strings are clipped to 2000 chars, arrays to 50 items.

| Area | Events |
|---|---|
| process | `proc.start` (non-secret config summary), `proc.stop` (signal), `proc.crash` |
| QQ edge | `qq.connected`, `qq.disconnected`, `qq.lifecycle`, `qq.frame_invalid`, `qq.api` (action, latency, outcome) |
| messages | `msg.in` (flags: self, mention, addressed, reply_to, queued), `msg.duplicate`, `msg.out` / `msg.out_failed` (per chunk) |
| group state machine | `queue.add`, `queue.restore`, `queue.persist_failed`, `wake.scheduled` (drawn wait, mean, whether it replaced an earlier one), `wake.fire`, `group.state` (`idle` / `waiting` / `running` with the reason), `run.start` (batch size, ids, age of the oldest message), `run.end` (ok, duration, dropped, error) |
| conversation | `session.start`, `conv.restore`, `turn.start` (context size), `turn.end` (duration, calls, persisted seq), `turn.rollback` (why a turn was discarded), `turn.nudge` (addressed but no `send`: one reminder turn follows, `kind` = `nudge`), `flush.start` / `flush.ok` / `flush.fail`, `compact.done` / `compact.skip` (tokens before/after), `conv.state` (`fresh` → `flushing` → `flushed` → `fresh`) |
| model and tools (from Pi) | `llm.response` (model, stop reason, tokens and cost, latency, tools requested, error), `llm.retry`, `tool.start` / `tool.end` (arguments summary, latency, error flag, result size, `terminate`), `pi.compaction.*` |
| backfill | `backfill.start`, `backfill.done` (stored, pages, why it stopped), `backfill.skip`, `backfill.fail` |
| Colab and shutdown | `colab.exec` (group, call id, exit code, timeout, duration), `colab.state` (`creating` / `ready` / `stopped` with the reason), `responder.halt` (cancelled wake-ups, runs in progress); `run.end` then carries `kept` |

**Privacy.** By default no message text, tool arguments or results are recorded, only sizes, ids and names (tool arguments keep identifying fields such as `path` and `query`). `TRACE_CONTENT=true` adds clipped text, prompts, arguments and results; the log then contains chat content, so protect it like the database.

**Rotation.** The live file `agent.jsonl` is rotated before a write that would pass `TRACE_MAX_FILE_MB`, and when the local date changes (including a file left from an earlier day by a previous process). A rotated file is renamed (so a `tail -F` reader never sees half a line) to `agent.<YYYYMMDD-HHmmss>.jsonl` and gzipped (`TRACE_COMPRESS`). After each rotation and at startup, rotated files beyond the newest `TRACE_MAX_FILES` or whose last write is older than `TRACE_MAX_AGE_DAYS` are deleted. Unrelated files in the directory are never touched. Writing is synchronous and failure-proof: an unwritable directory disables the log with a warning at startup, a later write error costs events but never the bot (warned about at most once a minute).

```
tail -F data/logs/agent.jsonl | jq -c .                                             # follow live
jq -c 'select(.run=="<run id>")' data/logs/agent.jsonl                              # everything in one wake-up
zcat data/logs/agent.*.jsonl.gz | cat - data/logs/agent.jsonl | jq -s '[.[]|select(.ev=="llm.response")|.usage.cost]|add'   # total model cost
jq -c 'select(.ev=="run.end" and .ok==false)' data/logs/agent.jsonl                 # failed runs
```

## State in one file
- `DB_PATH` (default `data/bot.db`). Back it up by copying the file (stop the bot first, or use SQLite's backup API; WAL mode adds `-wal`/`-shm` files while running).
- Schema is managed by a small forward-only migrator (`src/db/migrations/`, applied on open).
- **Filesystem**: table `files` (`src/vfs.ts`). Paths are absolute from `/`; `..` cannot leave the root; there is no host disk behind it, and it starts empty. Default quotas: 1 MiB per file, 64 MiB total.
- **System prompt**: the host file `prompts/agent.md` (`PROMPT_FILE`), used verbatim as the system prompt. It is not part of the agent's filesystem, so the agent cannot read or change it; edit it like any file in the repo (it is read when a group's conversation starts, so restart the bot to apply it everywhere). The agent's own evolving self-profile is `/persona.md` in its filesystem, which the prompt tells it to read at the start of a conversation.
- Manage files from the host: `bun run fs ls|cat|put|import|export|rm` (run `bun run fs` for usage). `import` keeps files that already exist unless `--force`, so re-seeding never clobbers what the agent wrote. A fresh database needs no seeding.

## How it is locked down
- `src/agent.ts`: tool allowlist `read, write, edit, ls, find, grep, search_messages, view_image, send, send_image, stop` (+ `run_python` if `COLAB_ENABLED`). Built-in `bash` is never enabled; extensions, skills, prompt templates and context files are off; startup aborts if any other tool is active. `send` / `send_image` only post to the conversation's own group through the bot (text, or a stored picture by id).
- `run_python` runs one VFS `.py` file on a Colab CPU runtime, never on this host: the `colab` CLI gets a fixed argv (no shell), the script runs as the unprivileged user `rainfish-run`, and every process and temp file of that user is removed before and after each run (a kernel that is not root refuses to run). `TAVILY_API_KEY` is readable by the scripts; it is only masked in the output in its plain, reversed and base64 forms, so use a key with a limited quota.
- File tools are backed by `VirtualFs`, not the host disk. Pi's built-in `find`/`grep` (which shell out to `fd`/`rg`) are replaced by database-backed versions.
- Pi sessions are in memory; the conversation is rebuilt from the database on start.

## Surviving a restart
Persisted in the SQLite file and restored on start: every group message; the agent's files; each group's conversation (`agent_messages` + `agent_archives`, so compaction survives); the **queue of messages waiting for a wake-up** (`pending_messages`, with their `addressed` flag; re-armed by `PiResponder.restore()`, and removed only after the run that consumed them ends, so a crash mid-run replays the batch, which can at worst repeat a reply); whether the **memory flush** already ran in the current compaction cycle (`conversation_flags`); the bot's own sent messages (stored as they are sent), so "reply to the bot" is still recognised; and the Colab runs of the last hour (`colab_exec`, for `COLAB_EXEC_MAX_PER_HOUR`). Not persisted by design: wake-up timers (redrawn on restore), and a turn that was cut off mid-way (it never reached the history; its messages are replayed instead).

**Shutdown.** SIGINT/SIGTERM first halts the responder (no new wake-ups or runs, and no pending message is removed, so everything not yet answered replays after the restart), then stops the QQ client and releases Colab. A second signal exits at once.

## Console commands (`bun run bot`, typed on stdin)
`compact` archives the whole live context of every group; `clear` forgets it (live messages and archive; chat log, files and persona stay); `colab-stop` releases the Colab runtime now. Each waits for a run of that group in progress.

## QQ bot (NapCat / OneBot v11)
This program is a WebSocket **client**: point it at NapCat's WebSocket server and run

```
QQ_WS_URL=ws://127.0.0.1:3001 QQ_TOKEN=... QQ_GROUPS=123,456 bun run bot   # QQ_TOKEN / QQ_GROUPS optional
```

- Every group message is stored (SQLite FTS5, Chinese/Japanese segmented with `Intl.Segmenter`) and searchable by the agent through `search_messages`.
- **Wake-ups.** Messages do not each cost a model call. Per group, every message of a handled group (not just @-mentions) is queued and the agent is woken once the chat has gone quiet; it then sees everything queued in one prompt. "Quiet" is modelled as a one-dimensional exponential-decay Hawkes process (`src/wake-intensity.ts`): each message adds excitation: 1 for ordinary text, scaled by the keyword rules in the agent's own `/wake-rules.yaml` (questions, messages to the bot and help requests ×0.5–0.6, short closings ×0.8, a lone picture ×0.3; unfinished sentences ×2.5, arguments ×1.5, "be quiet" commands ×3 by default; matching rules multiply, clamped to 0.2–4). The agent can tune it itself: the file is created from the defaults if missing, reloaded when it changes, and an edit that does not parse (invalid YAML, weight outside 0.1–5, duplicate name, no condition…) fails with the reason and leaves the file unchanged, the excitation decays at rate `WAKE_DECAY_PER_SECOND` (β, half-life ln 2/β), and the wake-up is due when it has fallen to `WAKE_QUIET_THRESHOLD`: `τ = ln(S/θ)/β`. Only two numbers per group are kept (`S`, last update), no history. A lone message waits ~3 s, five messages within a second ~7 s, so a lively exchange is not interrupted. On top of that comes a random reaction time (exponential, mean `WAKE_CHAT_MEAN_SECONDS`, or `WAKE_ADDRESSED_MEAN_SECONDS` once a pending message @-mentions the bot or replies to it; such messages carry `addressed="true"` in the prompt). Every arriving message recomputes the due time; it is bounded by `WAKE_MAX_WAIT_SECONDS` from the first pending message (`WAKE_ADDRESSED_MAX_WAIT_SECONDS` from the first addressed one) and `WAKE_MAX_BATCH` pending messages wake the agent at once. Runs of a group never overlap; messages arriving during a run wait for the next wake-up. If a run fails, its messages are dropped (still stored and searchable), not retried.
- **`send` tool.** The agent speaks only through `send(text, reply_to?)`; its plain output is not delivered. `send` can be called several times per run (one message per call, posted in call order; at most `SEND_MAX_PER_RUN`, paused `SEND_GAP_MS` apart) and does not end the run: the `stop` tool does. A step that contains `stop` ends as a whole (`[send, send, stop]` costs one model call) unless one of its calls failed, in which case the agent is called again and can retry. Long text is split, and `reply_to` quotes a message id (the `id` attribute of each `<message>`; a synthetic id such as a poke's cannot be quoted, so the message is sent without a quote). Not sending is how it stays silent.
- **Pictures.** Pictures of incoming messages are downloaded when they arrive and kept in the database (`IMAGE_STORE_MAX_BYTES`, least recently used deleted first; the SQLite file is shrunk back afterwards). Each has an id like `i42`, shown as `image_ids` on the `<message>` and as `[图片: i42]` in `search_messages`. `view_image(id)` shows a stored picture; `send_image(id, text?, reply_to?)` posts it (inline base64; only pictures of the agent's own group). What a picture shows is not stored by the program: the agent writes it into its notes next to the id. The model gets a scaled-down copy (same aspect ratio; `IMAGE_MODEL_MAX_PIXELS`, default 800k px ≈ 1100 tokens; `view_image` with `detail` gets a larger one); `bun run image-preview <picture>` shows what survives at each budget. The agent's `/persona.md` is pinned at the top of every request, so pruning and compaction never drop it.
- One agent conversation per group, resumed from SQLite.
- **History backfill.** After the first connection, every handled group (`QQ_GROUPS`, or every group from `get_group_list` if unset) with fewer than `BACKFILL_MIN_MESSAGES` (100) stored messages gets its history pulled with NapCat's `get_group_msg_history`: newest first, 100 per call, paging back by `message_seq`, keeping only messages from the last `BACKFILL_MAX_AGE_DAYS` (5) days, until 100 such messages are collected. It stops early at the first message older than the limit (everything further back is older) or when the history ends, and never stores anything older than the limit. The messages are stored and searchable but do not wake the agent. A failing group is logged and skipped. `BACKFILL_MIN_MESSAGES=0` disables it.
- Enable NapCat's `reportSelfMessage` (optional) so the bot's own messages are stored as well.
- All incoming frames are validated with Zod at the edge (`src/qq/`); invalid ones are logged and dropped. Environment config is validated at startup too.
- Without a model API key the bot still stores messages and logs a failed reply.
