# Contributing

Forks and PRs welcome. The bar is simple: `npm run check` passes, the change
explains itself, and the docs moved with the code.

## Setup

```bash
git clone https://github.com/<you>/worktree-optimiser.git
cd worktree-optimiser
npm install
npm run doctor        # verifies Docker, ports, git, Node — and names the fix if not
```

Node ≥ 20 (20.12+ if you want `.env` files read), git ≥ 2.20, Docker for running
the thing and for the integration test. Windows, macOS and Linux are all
first-class — most of the hard-won code exists *because* of the differences
between them.

## Development loop

```bash
npm run dev           # manager from source, restarts on change
npm run dev:web       # dashboard with HMR on :7788, proxying /api to the manager
```

Or the built path (`npm run build && npm start`) when you're touching the bin
entry point or packaging.

## Before you open a PR

```bash
npm run check         # lint + typecheck + 100 unit tests, no Docker needed
npm run test:integration   # only if you touched docker.ts — CI runs it regardless
```

- **One concern per PR.** A fix and a refactor are two PRs.
- **Tests move with behaviour.** New behaviour gets a unit test; container
  behaviour belongs in the integration test, not a mocked unit test.
- **Docs move with endpoints.** A route change lands with its `docs/api.md`
  section and the README endpoint list in the same commit.
- **Commit messages** follow the existing log: imperative subject, a body that
  explains the reasoning and what you verified. `git log` is the style guide.

## What to know before changing things

[AGENTS.md](AGENTS.md) is the working contract for this codebase — the
invariants a change must not break (no database, control plane not supervisor,
loopback-by-default, path containment, opt-in destructive tools) and the
platform gotchas that look like bugs but aren't. It's written for coding agents
and applies equally to humans; read it before your first PR. Architecture
reasoning is in [docs/architecture.md](docs/architecture.md).

If you're using a coding agent (Claude Code, Cursor, Codex, …), it will pick up
[AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) automatically — and you can
point it at this repo's own MCP server to run each task in its own worktree; see
[docs/mcp.md](docs/mcp.md).

## Forking for your own thing

MIT licensed — build on it freely. If you keep the packaging:

- `package.json` → `name`, `repository`, `author`, and the `bin` name are yours
  to change; `prepublishOnly` already builds everything a tarball needs.
- The published entry point is `bin/worktree-optimiser.js`; it dispatches to
  built `dist/` files, so a fork works with `npm pack` out of the box.
- `WT_*` environment variables and the `wt-` container/volume/network prefixes
  are defined in `apps/manager/src/config.ts` if you want to rebrand cleanly
  without colliding with an installed original.
