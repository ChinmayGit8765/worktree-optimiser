# Configuration

Two layers: **environment variables** configure the manager itself, **project config**
configures how one repo is run. Neither requires a file to get started — the defaults
work and detection fills in the rest.

## Environment

Copy `.env.example` to `.env`, or export these directly. Every value is optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WT_PORT` | `7777` | Manager API + dashboard port |
| `WT_HTTP_PORT` | `80` | Host port Traefik listens on |
| `WT_TRAEFIK_DASHBOARD_PORT` | `8088` | Traefik's own dashboard |
| `WT_DOMAIN` | `localhost` | Primary wildcard domain |
| `WT_ALT_DOMAIN` | `localtest.me` | Fallback domain for non-browser clients |
| `WT_NETWORK` | `wt-net` | Docker bridge network name |
| `WT_TRAEFIK_IMAGE` | `traefik:v3.3` | Proxy image |
| `WT_DATA_DIR` | `./data` | Where `projects.json` is written |
| `WT_BIND_STYLE` | auto | `win` \| `wsl` \| `unix` — bind path conversion |
| `WT_DOCKER_SOCKET` | auto | Override the Docker socket path |
| `WT_LOG_LEVEL` | `info` | Fastify/pino log level |
| `WT_HOST` | `127.0.0.1` | Manager bind interface. Non-loopback requires `WT_TOKEN` |
| `WT_TOKEN` | unset | Bearer token required for `/api/*` when set |
| `WT_HTTP_BIND` | `127.0.0.1` | Interface Traefik publishes worktree ports on |
| `WT_ALLOWED_HOSTS` | -- | Extra Host header values to accept (rebinding guard) |
| `WT_ALLOWED_ORIGINS` | -- | Extra browser origins allowed to read API responses |
| `WT_PORT_FALLBACK` | `true` | Publish a direct loopback port per worktree |
| `WT_PORT_RANGE` | `31000-31999` | Range those ports are allocated from |
| `WT_DEFAULT_CPUS` | `2` | Default CPU cap per container (0 = unlimited) |
| `WT_DEFAULT_MEMORY_MB` | `4096` | Default memory cap per container (0 = unlimited) |
| `WT_IDLE_STOP_MINUTES` | `0` | Stop a worktree after N minutes with no requests (0 = off) |
| `WT_MANAGER_URL` | `http://localhost:7777` | Dev-only: Vite's proxy target |

### If port 80 is taken

```bash
WT_HTTP_PORT=8080 npm start
```

Worktree URLs become `http://main.localhost:8080`. The manager builds URLs from this
value, so the dashboard links stay correct automatically.

### Bind path conversion

Docker bind sources must be written the way the *daemon* expects, which is not the way
Windows writes paths.

| Style | Produces | Use when |
| --- | --- | --- |
| `win` | `C:/dev/app` | Docker Desktop on Windows (default on win32) |
| `wsl` | `/mnt/c/dev/app` | daemon running directly inside WSL |
| `unix` | unchanged | Linux / macOS (default elsewhere) |

Auto-detected from the platform. Override only if binds fail with "invalid mount path".

### Idle stop

Off by default. Set `WT_IDLE_STOP_MINUTES=30` and any worktree that has served no
request through the proxy for 30 minutes is stopped.

It only ever stops. The worktree, its branch and its `node_modules` volume all
survive, so restarting is quick and nothing is lost — which is why it is safe to
leave on. Activity is read from Traefik's access log, which records the router name
for every request; that name is the container name, so it maps back exactly.

Last-seen times are held in memory. After a manager restart nothing has a recorded
visit, so the clock starts fresh on first sight: every container gets a full idle
window before it can be stopped. Measuring from the container's start time instead
would reap a long-running container the moment the manager restarted, even if it had
been in use seconds earlier.

## Project configuration

One entry per registered repo in `data/projects.json`. Detection writes it; you can edit
any field afterwards through `PATCH /api/projects/:id`.

```jsonc
{
  "id": "my-app",                    // slug; used in container + volume names
  "name": "my-app",                  // display name
  "repoPath": "C:\\dev\\my-app",     // the primary checkout
  "worktreesRoot": "C:\\dev\\my-app-worktrees",
  "runtime": "node",                 // node | python | static | custom
  "image": "node:22-bookworm-slim",
  "workdir": "",                     // subdir inside the worktree; "" = repo root
  "install": "npm install",          // null to skip
  "dev": "npm run dev -- --host 0.0.0.0 --port 5173",
  "containerPort": 5173,             // port the dev server listens on *inside* the container
  "env": { "PORT": "5173" },
  "volumePaths": ["/workspace/node_modules"],
  "watchPolling": true,
  "cpuLimit": 2,
  "memoryLimitMb": 4096,
  "packageManager": "npm"
}
```

### Field notes

**`containerPort`** must match whatever `dev` actually binds. It's what the Traefik
service label points at. If they disagree you get a 502.

**`workdir`** is relative to the worktree root, and is where `install` and `dev` run. For
a monorepo this is the app directory (`apps/web`), not the repo root.

**`volumePaths`** are container-absolute paths mounted as named volumes on top of the
bind mount. Always include `node_modules`; add build caches for write-heavy frameworks.
The volume name is derived as `wt-vol-<projectId>-<slug>-<suffix>`, so each worktree gets
its own — branches never share a `node_modules`.

**`watchPolling`** forces polling file watchers. Required on Windows and macOS bind
mounts. Set `false` on Linux, where inotify works natively and polling wastes CPU.

**`cpuLimit` / `memoryLimitMb`** cap the container, applied by default so a handful of
bundlers cannot starve the host; 0 disables either. Exceeding the memory cap kills the
container with exit code 137, which shows in the dashboard rather than freezing the
machine. 4096MB is deliberately generous -- bundlers routinely peak past 2GB.

**`env`** is merged over the defaults (`HOST=0.0.0.0`, `PORT`, `FORCE_COLOR=1`) and under
the polling variables. Use it for `NODE_ENV`, API base URLs, feature flags.

## What detection works out

| Detected | Read from | Produces |
| --- | --- | --- |
| Package manager | `packageManager` field, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `package-lock.json` | install command, whether to enable corepack |
| Node version | `engines.node`, `.nvmrc` | image tag, clamped to 18–24 |
| Framework | dependencies + `vite.config.*` | dev command, port, cache dirs |
| Monorepo layout | `workspaces`, `pnpm-workspace.yaml` | candidate apps to choose from |
| Python | `requirements.txt`, `pyproject.toml`, `manage.py` | pip install + runserver/uvicorn/flask |

### Framework defaults

| Framework | Port | Host flag | Cached dirs |
| --- | --- | --- | --- |
| Next | 3000 | `-H 0.0.0.0 -p` | `.next` |
| Nuxt | 3000 | `--host 0.0.0.0 --port` | `.nuxt`, `.output` |
| SvelteKit | 5173 | `--host 0.0.0.0 --port` | `.svelte-kit` |
| Astro | 4321 | `--host 0.0.0.0 --port` | — |
| Remix | 3000 | `--host 0.0.0.0 --port` | — |
| Gatsby | 8000 | `-H 0.0.0.0 -p` | `.cache`, `public` |
| Angular | 4200 | `--host 0.0.0.0 --port` | `.angular` |
| Create React App | 3000 | `HOST` env | — |
| Vite | 5173 | `--host 0.0.0.0 --port` | — |
| NestJS / Express / Fastify / Koa / Hono | 3000 | `HOST`/`PORT` env | — |
| Django | 8000 | `runserver 0.0.0.0:8000` | — |
| FastAPI | 8000 | `uvicorn --host 0.0.0.0` | — |
| Flask | 8000 | `flask run --host 0.0.0.0` | — |
| *(no match)* | 80 | static nginx fallback | — |

Detection ranks candidates by confidence and defaults to the highest. In a monorepo the
root package is **penalised by 30 points**, because a root `dev` script normally fans out
to several apps via turbo/nx — several ports, nothing sensible to route.

## Monorepos

For a workspace repo, detection enumerates every package with a `dev`/`start`/`serve`
script and presents them as choices. Pick the frontend app you actually want a URL for.

The generated config mounts **two** volumes:

```json
"volumePaths": [
  "/workspace/node_modules",              // hoisted root deps
  "/workspace/apps/web/node_modules"      // package-local deps
]
```

Both are needed. pnpm and npm workspaces hoist most dependencies to the root but leave
symlinks and some packages local; missing either one produces module-resolution failures
that look like corrupted installs.

To route more than one app from the same repo, register the repo twice with different
`id` and `workdir` values. Each gets its own hostname per branch.

## Custom setups

If detection can't work it out — an unusual dev server, a Makefile, a custom
entrypoint — register the project and then PATCH it:

```bash
curl -X PATCH http://localhost:7777/api/projects/my-app \
  -H 'Content-Type: application/json' \
  -d '{
        "image": "node:22-bookworm-slim",
        "install": "make deps",
        "dev": "make serve HOST=0.0.0.0 PORT=4000",
        "containerPort": 4000,
        "volumePaths": ["/workspace/node_modules", "/workspace/.cache"]
      }'
```

Then **Rebuild** each worktree from the dashboard to recreate its container with the new
settings. Rebuild recreates the container but keeps the volumes, so dependencies are not
reinstalled.

The container command is assembled as:

```sh
set -e
corepack enable 2>/dev/null || true    # only when packageManager != npm
<install>                              # skipped when null
exec <dev>
```

Anything valid in `sh` works, including `&&`, pipes, and subshells.
