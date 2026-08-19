# worktree optimiser

Run every branch of a repo as its own containerised dev server, all at once, each on its
own hostname — and manage the lot from one dashboard.

```
http://main.localhost                 →  worktree: main
http://feature-new-header.localhost   →  worktree: feature/new-header
http://fix-login.localhost            →  worktree: fix/login
http://localhost:7777                 →  the manager dashboard
```

No port juggling, no stopping one dev server to look at another, no stashing to switch
branches. Review a PR and your own work side by side in two tabs.

---

## Quick start

```bash
npx worktree-optimiser          # once published to npm
```

Or from a clone:

```bash
npm install
npm run build
npm start            # dashboard + API on http://localhost:7777
```

Open <http://localhost:7777>, click **Add project**, point it at any local clone. It
inspects the repo, proposes how to run it, and you confirm. Then **New worktree** for any
branch.

Requires Docker, Node 20+, git 2.20+. Run `npm run doctor` if anything misbehaves -- it
checks the environment and names the fix for each failure. Full walkthrough in
**[docs/getting-started.md](docs/getting-started.md)**.

---

## How it works

```
                     ┌────────────────────────────────────┐
    browser ─────────▶  Traefik  :80                      │  routes on Host header,
                     │  docker provider, reads labels     │  rebuilds routing when a
                     └──────────┬─────────────────────────┘  container starts
                                │  wt-net (bridge)
             ┌──────────────────┼──────────────────┐
             ▼                  ▼                  ▼
      ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
      │wt-app-main  │    │wt-app-feat… │    │wt-app-fix…  │  one container per worktree,
      └──────┬──────┘    └──────┬──────┘    └──────┬──────┘  bind-mounted to its checkout
             │                  │                  │
     C:\app-worktrees\main   \feature-…         \fix-…       git worktrees on the host
             ▲                  ▲                  ▲
             └──────────────────┴──────────────────┘
                                │ git worktree add/remove
      ┌─────────────────────────┴───────────────────────────┐
      │ manager :7777    Fastify + dockerode                │
      │ REST API · SSE logs · React dashboard               │
      └─────────────────────────────────────────────────────┘
```

Two design decisions shape everything else:

**The manager runs on the host, not in a container.** A git worktree's `.git` is a file
pointing at `<repo>/.git/worktrees/<name>`, which lives outside the worktree directory —
bind-mount only the worktree and git inside it breaks. Running on the host sidesteps this.

**There is no database.** git owns which worktrees exist; Docker labels own which
container belongs to which branch. State is re-derived from `git worktree list` plus
`docker ps`, so restarting the manager cannot desynchronise anything. The only persisted
file is the registry of repos you've added.

Consequently the manager is a **control plane, not a supervisor** — stopping it does not
stop your dev servers.

More in **[docs/architecture.md](docs/architecture.md)**.

---

## What detection works out

Point it at a repo and it produces a runnable config without you writing one: package
manager, Node version, framework, dev command, port, and which directories to keep off
the bind mount.

Supported out of the box — Next, Nuxt, SvelteKit, Astro, Remix, Gatsby, Angular, CRA,
Vite, NestJS, plain Node servers, Django, FastAPI, Flask, and a static nginx fallback.
For a monorepo it lists every workspace with a dev script and asks which to route.

Detection is a **suggestion, never silently applied** — what you see in the dialog is
what gets saved, and every field is editable afterwards.

Full table in **[docs/configuration.md](docs/configuration.md)**.

---

## The two details that make or break this

Both are verified, not assumed.

**Dev servers bind to `127.0.0.1` by default**, which inside a container means visible to
nothing. The container starts, the logs look perfect, and you get a 502. Every framework
profile forces `0.0.0.0` explicitly, in whatever form that framework accepts.

**inotify events don't cross the Windows/macOS → Linux container boundary**, so hot
reload dies silently. Containers get polling watchers by default. Two separate numbers,
both measured on a Windows bind mount: a host write is **visible inside the container in
~30ms** (the mount itself, asserted by the integration test), and a change reaches the
**browser in ~1s** through Vite's polling watcher (a 300ms poll interval plus rebuild).
Only the second involves polling; without it, it never arrives at all.

`node_modules` and build caches (`.next`, `.nuxt`, `.angular`, …) live on named volumes
rather than the bind mount. On Windows that is the difference between a usable dev server
and an unusable one.

---

## For coding agents (MCP)

An MCP server ships with the repo, so Claude Code can create a worktree, start it,
poll it for readiness, and read its logs without a human driving the dashboard.

```bash
claude mcp add worktree-optimiser -- node /abs/path/to/worktree-optimiser/apps/mcp/dist/index.js
```

Eleven tools by default: `list_projects`, `list_worktrees`, `list_branches`,
`probe_worktree`, `diagnose_worktree`, `get_logs`, `get_diff`, `create_worktree`,
`start_worktree`, `stop_worktree`, `restart_worktree`. All read-only or reversible.

`diagnose_worktree` is the one that earns its keep: it reads what the container is
actually listening on and returns a named cause — `bound-to-loopback`,
`port-mismatch` (naming the correct port), `installing`, `oom-killed` — instead of
leaving an agent to guess from a 502.

`delete_worktree` is **not registered** unless `WT_MCP_ALLOW_DESTRUCTIVE=true`. An agent
that can delete a worktree can destroy uncommitted work irrecoverably, so the default is
that the tool does not exist — a warning in a tool description is not an access control.

Full details in **[docs/mcp.md](docs/mcp.md)**.

---

## Safety rails

- The primary checkout can never be removed — only its container stopped.
- Worktree deletion refuses any path outside the project's configured worktrees root.
- Removing a worktree **keeps the branch**; only the checkout and container go.
- Deleting a worktree with uncommitted changes requires an explicit `force`.
- Containers have **no restart policy** — a crashed dev server stays crashed and visible
  rather than crash-looping quietly.
- Worktrees are created in a sibling directory, never inside the repo, so they never
  appear as untracked files in the parent checkout.
- Orphaned containers (worktree deleted behind the tool's back) are surfaced, not hidden.
- Every container is capped (2 CPUs, 4GB by default), so a dozen bundlers cannot take the
  machine down. Exceeding the cap kills one worktree, visibly, instead of freezing the host.
- Optional idle stop (`WT_IDLE_STOP_MINUTES`, off by default) only ever *stops* a container.
  The worktree, its branch and its dependency volumes are untouched.

---

## API

The dashboard is a client of the same REST API, so anything it does is scriptable.

```
GET    /api/system
GET    /api/system/doctor
POST   /api/system/proxy
GET    /api/projects
POST   /api/projects/detect                        { repoPath } → proposal
POST   /api/projects
PATCH  /api/projects/:id
DELETE /api/projects/:id
GET    /api/projects/:id/branches
POST   /api/projects/:id/fetch
GET    /api/projects/:id/worktrees
POST   /api/projects/:id/worktrees                 { branch, createBranch, baseRef, start }
POST   /api/projects/:id/worktrees/:slug/start     { recreate }
POST   /api/projects/:id/worktrees/:slug/stop
POST   /api/projects/:id/worktrees/:slug/restart
DELETE /api/projects/:id/worktrees/:slug?force&keepWorktree
GET    /api/projects/:id/worktrees/:slug/probe
GET    /api/projects/:id/worktrees/:slug/diagnose             named cause + fix
GET    /api/projects/:id/worktrees/:slug/logs?tail=N
GET    /api/projects/:id/worktrees/:slug/logs/json?tail=N     structured, ANSI stripped
GET    /api/projects/:id/worktrees/:slug/logs/stream          SSE
GET    /api/projects/:id/worktrees/:slug/files?path=
GET    /api/projects/:id/worktrees/:slug/file?path=
GET    /api/projects/:id/worktrees/:slug/diff?base=
GET    /api/projects/:id/worktrees/:slug/diff/patch?path=&origin=
```

Request and response shapes in **[docs/api.md](docs/api.md)**.

---

## Documentation

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install, register a repo, run a branch |
| [Architecture](docs/architecture.md) | How the pieces fit and why |
| [Configuration](docs/configuration.md) | Environment + per-project settings |
| [API reference](docs/api.md) | Every endpoint, with examples |
| [MCP server](docs/mcp.md) | Driving worktrees from a coding agent |
| [Troubleshooting](docs/troubleshooting.md) | 502s, dead hot reload, port conflicts |
| [Kubernetes backend](docs/kubernetes.md) | Planned migration path (not implemented) |

---

## Roadmap

- **Kubernetes backend** — the Traefik label shape maps onto an Ingress nearly
  one-to-one, and `docker.ts` is the only module that knows containers exist.
- **Claude UI review** — drive a headless browser against a worktree's URL, capture
  screenshots, and have Claude analyse the rendered frontend. Stable per-branch URLs and
  the readiness probe exist for exactly this.
- Per-worktree service dependencies (databases, queues) via compose fragments.

---

## Security

The manager deletes directories on the host and serves file contents from any registered
repo, so it binds `127.0.0.1` only, and Traefik publishes worktree ports on loopback too.
Exposing it to a network (`WT_HOST`) requires a token (`WT_TOKEN`) — the process refuses
to start otherwise. CORS is a strict allowlist rather than reflective, and a Host-header
allowlist blocks DNS rebinding. See [configuration](docs/configuration.md).

## Licence

MIT — see [LICENSE](LICENSE).

## Layout

```
apps/manager/src/
  index.ts       bootstrap: Fastify, static dashboard, Traefik, signals
  routes.ts      REST API, zod validation, SSE log streaming
  docker.ts      dockerode orchestration, Traefik labels, probe, log demux
  git.ts         worktree/branch operations, porcelain v2 parsing
  detect.ts      framework + runtime + package-manager detection
  worktrees.ts   joins git state to container state
  store.ts       project registry (atomic JSON)
  paths.ts       host → container bind path conversion
  slug.ts        branch → stable DNS-safe slug
apps/web/src/    React dashboard
apps/mcp/src/    MCP server for coding agents
docker/          standalone Traefik compose file
```
