# rain-fish

Pi-based assistant agent. Can list/search/read/write/edit files inside a sandbox directory; cannot execute code.

```
npm install
npm start            # REPL; sandbox = ./workspace (override: SANDBOX_DIR=/path)
npm test             # vitest: sandbox boundary + agent.md loading (no API key needed)
```

Credentials/model come from Pi's usual config (`~/.pi/agent`, or provider env vars such as `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`).

## How it is locked down
- `src/agent.ts`: tool allowlist `read, write, edit, ls, find, grep` — built-in `bash` is never enabled; extensions, skills, prompt templates and context files are disabled so nothing else can register tools. Startup aborts if any other tool is active.
- `src/sandbox.ts`: every tool is rebuilt with path-confined operations; paths are canonicalised (`realpath`) and rejected if outside the root — `..`, absolute paths, symlinks (incl. dangling) all refused.
- Sessions are in-memory only.

## System context
`<sandbox>/agent.md` (default `workspace/agent.md`) is the agent's system prompt, read at startup; startup fails if it is missing. Non-overridable rules (no code execution, sandbox-only) are appended in code, so editing `agent.md` cannot remove them. Note the agent can edit `agent.md` itself via `write`/`edit`; the change takes effect on the next session.

`<sandbox>/persona.md` is optional: the agent's own evolving self-profile (catchphrases, group lore, preferences). The agent maintains it via `write`/`edit`; if present it is appended to the system prompt on the next session start.
