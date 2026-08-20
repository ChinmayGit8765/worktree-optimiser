# Working in this repo (humans and agents)

worktree-optimiser runs every git worktree of a repo as its own containerised dev
server behind one Traefik proxy, managed from a Fastify API + React dashboard, with
an MCP server so coding agents can drive it. Architecture and reasoning live in
[docs/architecture.md](docs/architecture.md); this file is the working contract:
what to run, what not to break, and how to split work across parallel tasks.

## Commands

```bash
npm install                 # workspace root; installs all three apps
npm run check               # lint + typecheck + unit tests — the gate for every commit
npm run build               # web → manager/public, then manager and mcp via tsc
npm start                   # built manager + dashboard on :7777
npm run dev                 # manager from source (tsx watch)
npm run dev:web             # Vite dashboard on :7788, proxying /api to the manager
npm run doctor              # environment preflight; run it before blaming code
npm run test:integration    # real Docker lifecycle test — needs a running daemon
```

Unit tests do not need Docker; the git tests create real repos in temp dirs and
take a few seconds. Integration needs a daemon and pulls images — CI runs it on
every push, so skipping it locally is fine for changes that don't touch
`docker.ts`.

## Layout

```
apps/manager/src/   Fastify API — routes, docker orchestration, git, detection
apps/web/src/       React dashboard (a client of the same API, nothing more)
apps/mcp/src/       MCP adapter over the REST API — deliberately owns no logic
bin/                the npx entry point; dispatches to built dist/ files
docs/               reference docs; api.md must match routes.ts
```

Per-module map at the bottom of [README.md](README.md#layout).

## Invariants — do not break these

Each of these was a deliberate decision with a failure mode behind it. Changing
one is possible, but is an architecture discussion, not a side effect of a fix.

- **No database.** State is re-derived from `git worktree list` + `docker ps`
  (labels). Do not add caches or files that can desynchronise from them; the only
  persisted file is the project registry.
- **The manager is a control plane, not a supervisor.** Restarting it must never
  stop a dev server. No restart policies on containers, no cleanup-on-exit.
- **Loopback by default; network exposure requires a token.** The refusal to
  start in `index.ts` is a security control, not an inconvenience. CORS stays an
  allowlist, never reflective. Host-header checks guard DNS rebinding.
- **Every client-supplied path goes through containment.** `resolveInsideReal`
  re-checks after symlink resolution. New file-serving endpoints use it — the
  lexical check alone is not enough.
- **Destructive MCP tools are opt-in by absence.** `delete_worktree` is not
  registered without `WT_MCP_ALLOW_DESTRUCTIVE=true`. A warning in a tool
  description is not an access control; keep it that way for anything new that
  can destroy uncommitted work.
- **The primary checkout is never removed**, worktree deletion refuses paths
  outside the configured root, and removing a worktree keeps its branch.
- **`import './env.js'` stays the first import** in every manager entry point.
  `config.ts` reads `process.env` at module scope; ESM import order is the only
  thing making `.env` visible to it.
- **Detection proposes, never silently applies.** What the user confirms in the
  dialog is what is saved.

## Conventions

- Comments explain *why*, not what — most non-obvious lines in this codebase cite
  the failure they prevent. Match that; delete comments that merely restate code.
- Commit messages: imperative subject; body explains the reasoning and the
  failure mode, states what was verified, and ends with the passing test count.
  Read `git log` — the style is consistent and worth imitating.
- TypeScript strict, ESM throughout, zod at every API boundary. The eslint
  config is the non-type-checked preset on purpose (typecheck covers the rest).
- New behaviour gets a unit test in `apps/manager/test/unit/`; container
  behaviour goes in the integration test, not mocked unit tests.
- Docs are part of the change: a new endpoint lands with its `docs/api.md`
  section and the README endpoint list in the same commit.

## Parallel work — multiple tasks, multiple agents

This tool exists so parallel work doesn't collide; use it on itself.

- **One branch per task, one worktree per branch.** Never share a checkout
  between concurrent tasks. Worktrees live in a *sibling* directory
  (`../worktree-optimiser-worktrees/<slug>`), never inside the repo.
- **With the MCP server registered** (see [docs/mcp.md](docs/mcp.md)), the loop
  is: `create_worktree` (branch per task) → `start_worktree` → poll
  `probe_worktree` → on failure `diagnose_worktree` first, `get_logs` second —
  diagnose names the cause (`bound-to-loopback`, `port-mismatch`, `installing`,
  `oom-killed`) instead of leaving you to guess from a 502. `get_diff` shows what
  a task actually changed before you merge it.
- **Contention hotspots** are `routes.ts`, `docker.ts` and `docs/api.md` — most
  tasks touch them. If two parallel tasks both must, sequence those tasks or
  agree the split up front; everything else merges cleanly.
- **Each parallel task runs `npm run check` in its own worktree** before its
  commit. Builds write to per-checkout `dist/`, so parallel builds don't fight.
- **Merging**: rebase onto `main`, re-run `npm run check`, then fast-forward.
  Delete the worktree after merge; the branch survives deletion by design.

## Gotchas

- Windows paths: `toBindPath` classifies by the *input's* convention, not the
  host platform — don't "simplify" it back to `path.resolve` (see commit
  `ddc7358` for the bug that caused).
- CI runners already listen on `:80`; integration jobs run with
  `WT_HTTP_PORT=8080`. `*.localhost` resolves at OS level on Linux but not
  Windows — that asymmetry is why the direct loopback port per worktree exists.
- `.env` loading needs Node ≥ 20.12; older Nodes skip it with a warning and the
  doctor says so. Everything else runs on 20.0.
- Dev servers inside containers must bind `0.0.0.0`, and bind mounts need polling
  watchers on Windows/macOS. Both are handled per framework profile in
  `detect.ts` — new profiles must set both or they will appear to work and then
  502 / silently stop reloading.
