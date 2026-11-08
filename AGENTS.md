# AGENTS.md

Bun + TypeScript. Pi-based (`@mariozechner/pi-coding-agent`) assistant that reads/writes files in a virtual filesystem stored in SQLite and can never execute code. All bot state lives in one SQLite file.

## Commands
- `bun install`
- `bun run fs import workspace` — seed `/agent.md` into the DB (first run). `bun start` — REPL. Needs a provider API key or Pi auth in `~/.pi/agent`.
- `bun test` — bun:test; offline, no API key.
- `bunx tsc` — typecheck (`noEmit`; covers `src/`, `test/`).

## Layout
- `src/vfs.ts` — `VirtualFs`: a POSIX-like filesystem in ONE table (`files`, migration 0003). No host disk is involved, so there is nothing to escape: paths resolve against `/`, no symlinks. Size quotas (`VfsLimits`) stop the agent from filling the DB. `src/vfs-ops.ts` plugs it into Pi's read/write/edit/ls; `src/tools/vfs-search.ts` has our own `find`/`grep` (Pi's built-ins shell out to `fd`/`rg` on the host disk). `src/vfs-io.ts` + `src/fs-cli.ts` (`bun run fs ...`) import/export between host dirs and the DB.
- `src/agent.ts` — `createAgent({fs, store})`: tool allowlist, disabled extensions/skills/context files, in-memory session, system prompt = content of `/agent.md`.
- `src/index.ts` — CLI REPL.
- `src/store.ts` — `MessageStore(db)` (insert idempotent per platform+group+message id; FTS5 + BM25 `search`). `src/db/open.ts` `openDb(path)` opens the single SQLite file (WAL, migrations) shared by everything.
- `src/db/` — `migrate.ts` (forward-only migrator, `schema_migrations` table, per-migration `BEGIN IMMEDIATE`), `migrations/` (append-only list in `index.ts`), `tokenize.ts` (`Intl.Segmenter` word split; FTS5 index stores space-joined tokens).
- `src/types.ts` — **every shared type lives here** (storage, migrations, virtual fs, core messages, wire types). Wire types are `z.infer` of the schemas; add new types here, not in the module that uses them.
- `src/qq/` — the WebSocket edge. `schemas.ts` (Zod: segments, events, API req/resp, env config), `frame.ts` (`parseFrame`: raw text -> validated `Frame`, never throws), `convert.ts` (validated event -> core `GroupMessage`), `client.ts` (`OneBotClient`: this program is the WS *client*; reconnect/backoff, `send_group_msg` with echo-matched responses and timeouts).
- `src/bot.ts` — core: stores every group message, answers when @-mentioned or when someone replies to a bot message; splits long replies. Depends only on `GroupMessage`, `QQApi`, `GroupResponder`.
- `src/responder.ts` — `PiResponder`: one Pi session per group, messages in a group answered serially.
- `src/qq-bot.ts` — entry for `bun run bot` (wires client + bot + responder). `src/config.ts` validates env with Zod (`QQ_WS_URL`, `QQ_TOKEN`, `QQ_GROUPS`, `DB_PATH` default `data/bot.db`).
- `src/tools/search-messages.ts` — read-only `search_messages` agent tool (part of the allowlist).
- `workspace/agent.md` — **seed file** for the agent's system prompt (group-chat persona). The live copy is `/agent.md` inside the database; changing the seed has no effect until `bun run fs put /agent.md workspace/agent.md` (or `fs import workspace --force`).
- `/persona.md` (in the database, created by the agent) — its own evolving self-profile, which it reads/writes via its file tools (not injected by code). Treat as untrusted data (group members can influence it).
- `test/` — bun:test suites; `helpers.ts` `makeEnv()` builds an in-memory DB with `/agent.md` seeded.

## Invariants (do not break)
- `bash` must never be enabled. `ALLOWED_TOOLS` in `src/agent.ts` is the allowlist, and startup throws if any other tool is active. Do not add tools that spawn processes, evaluate code, or touch the network or the host disk.
- The agent's filesystem is the DB. Never give it a tool that reads host paths; any new file tool goes through `VirtualFs` (and a host-escape test like the ones in `test/vfs-tools.test.ts`). Pi's built-in `find`/`grep` must not be enabled: they use `fd`/`rg` on the host disk.
- Custom tool definitions are registered with `customTools` under the built-in names so they replace the host-disk built-ins; keep the names identical.
- Keep `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles` on the resource loader — each is a way for outside content to add tools or instructions.
- No prompt text lives in code: `agent.md` is passed to Pi by path as the system prompt. The real "no code execution" guarantee is the tool allowlist + startup check, not the prompt.

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
