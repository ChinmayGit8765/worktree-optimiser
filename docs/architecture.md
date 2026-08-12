# Architecture

## The shape of it

```
                     ┌────────────────────────────────────┐
    browser ─────────▶  Traefik  :80                      │  routes on Host header,
                     │  docker provider, reads labels     │  rebuilds its routing table
                     └──────────┬─────────────────────────┘  when a container starts
                                │  wt-net (bridge)
             ┌──────────────────┼──────────────────┐
             ▼                  ▼                  ▼
      ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
      │wt-app-main  │    │wt-app-feat… │    │wt-app-fix…  │   one container per worktree
      │/workspace ──┼──▶ │/workspace ──┼──▶ │/workspace ──┼─▶ bind-mounted to its checkout
      └─────────────┘    └─────────────┘    └─────────────┘
             │                  │                  │
     C:\app-worktrees\main   \feature-…         \fix-…        git worktrees on the host
             ▲                  ▲                  ▲
             └──────────────────┴──────────────────┘
                                │ git worktree add/remove
      ┌─────────────────────────┴───────────────────────────┐
      │ manager  :7777        Fastify + dockerode           │
      │ REST API · SSE logs · React dashboard (static)      │
      └─────────────────────────────────────────────────────┘
```

## Why the manager runs on the host

It could run in a container with the Docker socket mounted. It doesn't, for one reason:
**it has to run `git worktree` against real host paths**.

A git worktree's `.git` is a *file* containing a pointer to
`<repo>/.git/worktrees/<name>` — which lives outside the worktree directory. Bind-mount
only the worktree into a container and git inside it breaks, because the thing its
`.git` file points at isn't there. Running the manager on the host sidesteps this
entirely: git operations happen where the repository actually is, and containers only
ever need the working files.

## Why there is no database

State lives in two places that are already authoritative:

- **git** owns which worktrees exist, what branch each is on, and whether it's dirty.
- **Docker labels** own which containers belong to which project and branch.

```
wt.managed=true        every container this tool created
wt.project=<id>        project it belongs to
wt.branch=<branch>     the real branch name, unslugified
wt.slug=<slug>         DNS-safe identifier
wt.hostPath=<path>     host path of the worktree
wt.port=<port>         the port the dev server listens on
wt.role=proxy          set only on the Traefik container
```

The only persisted file is `data/projects.json`, the registry of which repos you've
added, written atomically (write-then-rename) so a crash can't truncate it.

The consequence: **restarting the manager cannot desynchronise anything**. It re-derives
the whole picture from `git worktree list` plus `docker ps`. There is no reconciliation
loop and no stale-state class of bug.

## The manager is a control plane, not a supervisor

Stopping the manager deliberately does **not** stop worktree containers. It is not their
parent and doesn't supervise them. Restarting the API must never kill someone's running
dev server mid-task.

Correspondingly, worktree containers get `RestartPolicy: no`. A dev server that crashes
on a syntax error stays crashed and visible in the dashboard, rather than crash-looping
silently and looking healthy-ish.

## How routing works

Traefik runs with the Docker provider and `exposedbydefault=false`, so it ignores every
container except ones explicitly labelled. Each worktree container carries:

```
traefik.enable=true
traefik.docker.network=wt-net
traefik.http.routers.wt-<project>-<slug>.rule=Host(`<slug>.localhost`) || Host(`<slug>.localtest.me`)
traefik.http.routers.wt-<project>-<slug>.entrypoints=web
traefik.http.services.wt-<project>-<slug>.loadbalancer.server.port=<containerPort>
```

Traefik watches the Docker event stream, so a route appears the moment a container
starts and disappears when it stops. No config file, no reload, no port bookkeeping.

Two hostnames per route on purpose:

- `*.localhost` — every major browser resolves this to loopback with no hosts-file edit,
  per RFC 6761. Non-browser clients often don't.
- `*.localtest.me` — a public DNS wildcard pointing at 127.0.0.1, which covers curl on
  Windows, scripts, and anything doing a real DNS lookup.

## Slugs

Branch names are far more permissive than DNS labels. `feat/ABC-123_Fix Thing` is a
legal branch and an illegal hostname, so every branch gets a slug used for the hostname,
the container name, and the Traefik router id.

```
feat/ABC-123_Fix Thing   →  feat-abc-123-fix-thing
release/2.0              →  release-2-0
2024-hotfix              →  b-2024-hotfix        (leading digit prefixed)
```

Slugs are **stable per branch** — computed from the branch name alone, not from
insertion order or from what else exists. A URL you bookmark keeps working. The one
exception is a genuine collision (`feat/a-b` and `feat/a_b` both slugify to `feat-a-b`),
where a short FNV-1a hash of the branch name is appended to disambiguate.

## Container composition

Each worktree container is built from the project config:

```
image        node:22-bookworm-slim        derived from engines.node / .nvmrc
WorkingDir   /workspace/<workdir>
Cmd          sh -lc "set -e
                     corepack enable 2>/dev/null || true
                     npm install
                     exec npm run dev -- --host 0.0.0.0 --port 5173"
Binds        C:/app-worktrees/feat:/workspace
             wt-vol-app-feat-node-modules:/workspace/node_modules
NetworkMode  wt-net
Init         true
```

Three details are load-bearing:

**`exec` on the last step.** The dev server becomes the direct signal target rather than
a child of a shell that ignores SIGTERM. `docker stop` then takes about a second instead
of hitting the ten-second kill timeout every time.

**`Init: true`.** Node dev servers spawn child processes freely; without an init process
reaping them, stopped containers leave zombies.

**Named volumes over the bind mount.** `node_modules` and framework caches (`.next`,
`.nuxt`, `.angular`, `.svelte-kit`, `.cache`) are mounted as named volumes *on top of*
the bind mount. Docker allows a volume at a path inside a bind, and the volume wins.
Those directories are write-heavy with tens of thousands of small files; leaving them on
a Windows bind mount is the difference between a usable dev server and an unusable one.

## The two boundary problems

Everything hard about this design is the host↔container boundary. Two failure modes
account for nearly all of it.

### Dev servers bind to loopback

Almost every dev server defaults to `127.0.0.1`. Inside a container that means "visible
to nothing". The container starts, the logs look perfect, and Traefik returns 502.

So every framework profile forces `0.0.0.0` explicitly, in the form that framework
accepts:

| Framework | Mechanism |
| --- | --- |
| Vite, Nuxt, SvelteKit, Astro, Remix, Angular | `--host 0.0.0.0 --port <n>` |
| Next, Gatsby | `-H 0.0.0.0 -p <n>` |
| Create React App | `HOST=0.0.0.0` env var (no flag exists) |
| Everything else | `HOST` / `PORT` env vars |

`HOST=0.0.0.0` and `PORT` are always set as a backstop.

### inotify doesn't cross the boundary

File change events do not propagate from a Windows host into a Linux container over the
virtiofs/9p layer. Watchers register successfully and then simply never fire — hot
reload dies silently, which is worse than failing loudly.

Containers therefore get polling watchers by default:

```
CHOKIDAR_USEPOLLING=true      CHOKIDAR_INTERVAL=300
WATCHPACK_POLLING=true        NEXT_WEBPACK_USEPOLLING=1
VITE_SERVER_WATCH_USEPOLLING=true
```

Measured propagation on a Windows bind mount: **~1 second** from host write to updated
response. Set `watchPolling: false` per project on Linux, where inotify works natively
and polling is just wasted CPU.

## Readiness probing

`GET /api/projects/:id/worktrees/:slug/probe` issues a request to `127.0.0.1:<httpPort>`
with `Host: <slug>.localhost` — the same path a browser takes. It distinguishes:

- container not running → unreachable
- container running, server not up yet → unreachable
- server up but bound to loopback → Traefik 404/502
- fully working → 200

This is implemented with `node:http`, not `fetch`. **`Host` is a forbidden header for
fetch**, which drops it silently; the request then arrives at Traefik with no matching
route and every probe reports a bogus 404. (This was a real bug, caught in testing.)

## Log streaming

Docker's non-TTY log stream multiplexes stdout and stderr behind an 8-byte header per
frame. `demuxDockerStream` strips the framing, with a heuristic to pass TTY streams
(which have no framing) through untouched.

The transport is Server-Sent Events rather than WebSockets: log tailing is
one-directional, and SSE reconnects on its own with no client-side plumbing. The client
keeps a bounded 2000-line buffer — a webpack build can emit tens of thousands of lines
and would otherwise pin the tab at 100% CPU.

## Module layout

```
apps/manager/src/
  index.ts       bootstrap: Fastify, CORS, static dashboard, Traefik, signals
  routes.ts      REST API, zod validation, SSE log streaming
  docker.ts      dockerode orchestration, Traefik labels, probe, log demux
  git.ts         worktree/branch operations, porcelain v2 parsing
  detect.ts      framework + runtime + package-manager detection
  worktrees.ts   joins git state to container state; create/destroy lifecycle
  store.ts       project registry, atomic JSON, HttpError
  paths.ts       host → container bind path conversion, containment guard
  slug.ts        branch → stable DNS-safe slug
  config.ts      env-driven constants, label names, URL builders
  types.ts       zod schemas + shared types
```

`docker.ts` is the only module that knows about containers. That is deliberate — it is
the seam a Kubernetes backend would replace. See [kubernetes.md](./kubernetes.md).
