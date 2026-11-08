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
`<sandbox>/agent.md` (default `workspace/agent.md`) is passed to Pi as the system prompt; startup fails if it is missing. No prompt text is hard-coded. The agent can edit `agent.md` via `write`/`edit` (effective next session); code-execution is blocked by the tool allowlist, not by the prompt.

`<sandbox>/persona.md` is optional: the agent's own evolving self-profile. `agent.md` instructs it to `read` the file at the start of a conversation and update it as it learns.
