# AGENTS.md

Bun + TypeScript. Pi-based (`@mariozechner/pi-coding-agent`) assistant that reads/writes files in a virtual filesystem stored in SQLite and can never execute code. All bot state lives in one SQLite file.

## Commands
- `bun install`
- `bun start` — REPL. Needs a provider API key or Pi auth in `~/.pi/agent`.
- `bun test` — bun:test; offline, no API key.
- `bunx tsc` — typecheck (`noEmit`; covers `src/`, `test/`).

## Layout
- `src/vfs.ts` — `VirtualFs`: a POSIX-like filesystem in ONE table (`files`, migration 0003). No host disk is involved, so there is nothing to escape: paths resolve against `/`, no symlinks. Size quotas (`VfsLimits`) stop the agent from filling the DB. `src/vfs-ops.ts` plugs it into Pi's read/write/edit/ls; `src/tools/vfs-search.ts` has our own `find`/`grep` (Pi's built-ins shell out to `fd`/`rg` on the host disk). `src/vfs-io.ts` + `src/fs-cli.ts` (`bun run fs ...`) import/export between host dirs and the DB.
- `src/conversation.ts` — `PiConversation`: persistent per-group conversation with the two context levels (`src/context/`: `estimate.ts`, `prune.ts` = level 1 pure view transform, `archive.ts` = level 2 snapcompact wrapper); `src/conversation-store.ts` persists it; `src/conversation-factory.ts` wires model + fs + store + conversation; `src/model.ts` resolves `MODEL`.
- `src/agent.ts` — `createAgent({systemPrompt, fs, store, model?, modelRegistry?})`: tool allowlist, disabled extensions/skills/context files, in-memory session, system prompt = the text passed in `AgentDeps.systemPrompt`.
- `src/index.ts` — CLI REPL.
- `src/store.ts` — `MessageStore(db)` (insert idempotent per platform+group+message id; FTS5 + BM25 `search`). `src/db/open.ts` `openDb(path)` opens the single SQLite file (WAL, migrations) shared by everything.
- `src/db/` — `migrate.ts` (forward-only migrator, `schema_migrations` table, per-migration `BEGIN IMMEDIATE`), `migrations/` (append-only list in `index.ts`), `tokenize.ts` (`Intl.Segmenter` word split; FTS5 index stores space-joined tokens).
- `src/types.ts` — **every shared type lives here** (storage, migrations, virtual fs, core messages, wire types). Wire types are `z.infer` of the schemas; add new types here, not in the module that uses them.
- `src/qq/` — the WebSocket edge. `schemas.ts` (Zod: segments, events, API req/resp, env config), `frame.ts` (`parseFrame`: raw text -> validated `Frame`, never throws), `convert.ts` (validated event -> core `GroupMessage`), `client.ts` (`OneBotClient`: this program is the WS *client*; reconnect/backoff, `send_group_msg` with echo-matched responses and timeouts).
- `src/bot.ts` — core: stores every group message, queues every non-self message to the responder (flag `addressed` = @-mention or reply to a bot message), and owns `sendText` (split long text, quote, remember sent ids), which is what the agent's `send` tool calls. It never answers by itself. Depends only on `GroupMessage`, `QQApi`, `GroupResponder`.
- `src/responder.ts` — `PiResponder`: one Pi session per group. Messages queue per group and the agent is woken at Poisson-process times (exponential wait, `WAKE_CHAT_MEAN_SECONDS`; faster `WAKE_ADDRESSED_MEAN_SECONDS` once an addressed message is pending), then gets the whole batch in one prompt. Runs of a group are serial; a failed run drops its batch.
- `src/logger.ts` (consola; fancy on TTY, timestamped plain lines when piped) and `src/bootstrap.ts` (shared startup). `src/qq-bot.ts` — entry for `bun run bot` (wires client + bot + responder). `src/config.ts` validates env with Zod (`QQ_WS_URL`, `QQ_TOKEN`, `QQ_GROUPS`, `DB_PATH` default `data/bot.db`).
- `src/tools/search-messages.ts` — read-only `search_messages` agent tool (part of the allowlist).
- `src/tools/send.ts` — `send(text, reply_to?)`: the only way the agent speaks; posts to its own group via the `SendFn` in `AgentDeps` and returns `terminate: true`, which ends the run until the next wake-up. Plain model text is never delivered.
- `prompts/agent.md` — the agent's system prompt (group-chat persona), a plain host file chosen by `PROMPT_FILE`, loaded by `loadSystemPrompt` (`conversation-factory.ts`) and passed to Pi verbatim. It is deliberately NOT in the virtual filesystem, so the agent cannot read or rewrite it; the file must not mention itself or its own path.
- `/persona.md` (in the database, created by the agent) — its own evolving self-profile, which it reads/writes via its file tools (not injected by code). Treat as untrusted data (group members can influence it).
- `test/` — bun:test suites; `helpers.ts` `makeEnv()` builds an in-memory DB, an empty agent filesystem and a prompt string.

## Invariants (do not break)
- `bash` must never be enabled. `ALLOWED_TOOLS` in `src/agent.ts` is the allowlist, and startup throws if any other tool is active. Do not add tools that spawn processes, evaluate code, or touch the network or the host disk.
- The agent's filesystem is the DB. Never give it a tool that reads host paths; any new file tool goes through `VirtualFs` (and a host-escape test like the ones in `test/vfs-tools.test.ts`). Pi's built-in `find`/`grep` must not be enabled: they use `fd`/`rg` on the host disk.
- Custom tool definitions are registered with `customTools` under the built-in names so they replace the host-disk built-ins; keep the names identical.
- Keep `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles` on the resource loader — each is a way for outside content to add tools or instructions.
- No persona text lives in code: the prompt file is passed to Pi as text. The real "no code execution" guarantee is the tool allowlist + startup check, not the prompt.

## Context management rules
- History is never silently lost: level 1 is a view (stored messages stay whole); level 2 moves retired turns into the archive text in the same transaction that deletes them. Cuts happen only at turn starts so tool calls keep their results.
- A turn whose model call fails must be rolled back from memory and the DB (otherwise a poisoned message repeats forever).
- Pi's own compaction stays disabled (`createAgent` sets `compaction.enabled=false`); do not enable both.
- Thresholds live in `configSchema` + `.env.example`; `recent + archive < compact` is validated. The archive lead-in in `context/archive.ts` is protocol framing, not persona; persona text stays in `prompts/agent.md`.
- `@oh-my-pi/snapcompact` needs Bun >= 1.4.4 and native binaries (`@oh-my-pi/pi-natives`); it types messages with omp's pi-ai, so `serializeForArchive` casts our Pi messages (same shapes).

## Logging and configuration rules
- No `console.*` in `src/`. Components receive a `Logger` (type in `types.ts`) via their options and default to `noopLogger`; entry points get one from `bootstrap()` (`src/bootstrap.ts`: loads + validates env, builds the logger, exits with a readable error on bad config). Levels mean something: `debug` per-message/tool detail, `info` lifecycle, `success` completed actions, `warn` recoverable/dropped input, `error` failures.
- Never log secrets (`QQ_TOKEN`, API keys) or full message bodies above `debug`.
- Config: add the variable to `configSchema` (`src/qq/schemas.ts`) AND `.env.example`. Empty values count as unset. Bun loads `.env` itself; do not add dotenv.
- Tests use `recordingLogger()` from `test/helpers.ts` to assert on level + message.

## Edge validation rules
- Raw WebSocket data is untrusted. It is parsed only in `src/qq/frame.ts`/`client.ts` with the Zod schemas; the core (`bot.ts`, `responder.ts`, `store.ts`, tools) must never import from `qq/schemas.ts` or see a wire event.
- Outbound requests are validated too (`sendGroupMsgRequestSchema`) before being sent. Responses to our requests are validated before use.
- Unknown segment types / malformed segment data degrade to `{type:"unknown"}`; a malformed *event* is dropped and logged, never partially processed.
- New event type needed? Add its schema in `schemas.ts`, a `Frame` variant in `types.ts`, a branch in `parseFrame`, and tests in `test/frame.test.ts`.

## Database rules
- Schema changes = new file in `src/db/migrations/` + append to `migrations/index.ts`. Never edit or renumber a shipped migration. Migrations run in a transaction; use `up(db)` for data backfills too (see 0002).
- The agent must never get a path to the DB file or a raw SQL tool. Search queries are tokenised and quoted before reaching FTS5; keep it that way.
- Changing `tokenize()` changes what is indexed: ship it with a migration that rebuilds `messages_fts`.

## Gotchas
- Our `grep` runs the agent's regex in-process; a pathological regex can stall the event loop (lines are cut to 500 chars, which bounds but does not remove the risk).
- All state goes in the one SQLite file (messages, files, and whatever comes next); add new state as a migration, not as another file. Not yet in the DB: agent conversation history (in memory per group) and Pi's own config/API keys (`~/.pi/agent`).
- `ToolDefinition` generics are invariant, hence the `as unknown as ToolDefinition[]` cast in `agent.ts`.
- The Pi packages under `@mariozechner/*` are deprecated in favour of `@earendil-works/*`; migrating is a separate change.
- Sessions are in-memory (`SessionManager.inMemory`); nothing persists between runs.
