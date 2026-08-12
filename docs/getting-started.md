# Getting started

## Requirements

| | Minimum | Checked with |
| --- | --- | --- |
| Docker | Engine 24+ / Desktop 4.30+ | `docker info` |
| Node | 20 | `node --version` |
| git | 2.20 (worktree porcelain v2) | `git --version` |

On Windows, Docker Desktop must be **running** before you start the manager — the
manager degrades gracefully if it isn't (the dashboard shows the error) but nothing can
start until the daemon is reachable.

## Install and run

```bash
git clone https://github.com/ChinmayGit8765/worktree-optimiser.git
cd worktree-optimiser
npm install
npm run build
npm start
```

Open <http://localhost:7777>.

On first start the manager creates the `wt-net` bridge network, pulls `traefik:v3.3`,
and starts the proxy on port 80. That takes a few seconds once, then never again.

### Development mode

Two processes, so the dashboard hot-reloads:

```bash
npm run dev        # manager on :7777, restarts on change
npm run dev:web    # dashboard on :7788, proxies /api → :7777
```

Use <http://localhost:7788> while working on the UI.

## Registering your first project

1. Click **Add project**.
2. Enter an absolute path to a local clone — `C:\dev\my-app` or `/home/me/my-app`.
3. Click **Inspect repo**.

The manager reads the checkout and proposes a runnable config: base image, install
command, dev command, port, and which cache directories to keep off the bind mount. For
a monorepo it lists every workspace that has a dev script and asks which one to route,
because a root `dev` script normally starts several servers at once and there is no
single port to route.

Nothing is applied silently — what you see in the dialog is exactly what gets saved. You
can edit any of it later via `PATCH /api/projects/:id`.

4. Confirm. The project appears in the sidebar with its primary checkout listed as a
   worktree (marked `primary`), not yet running.

## Running a branch

Click **New worktree**, then either:

- **Existing branch** — pick from local and remote branches. Anything already checked
  out in another worktree is excluded, because git allows a branch in exactly one
  worktree at a time. Hit **Fetch remotes** to refresh the list.
- **New branch** — name it and choose a base ref (defaults to the repo's default
  branch, resolved from `origin/HEAD`).

Leave **Start the container immediately** ticked and the manager will:

1. `git worktree add` into the project's worktrees directory
2. create a container bind-mounted to that checkout
3. run the install command, then the dev command
4. register a Traefik route for `<slug>.localhost`

**The first run is slow** — it is a cold dependency install. Watch it happen by clicking
**Logs**. Subsequent starts reuse the named `node_modules` volume and are fast.

## What you end up with

```
http://main.localhost                 →  worktree: main
http://feature-new-header.localhost   →  worktree: feature/new-header
http://fix-login.localhost            →  worktree: fix/login
```

All running at once. Open two in adjacent tabs and compare a PR against your own work
without stopping anything or stashing.

## Where things live on disk

```
<repo>/                              your clone, untouched
<repo>-worktrees/                    generated checkouts, one dir per slug
  feature-new-header/
  fix-login/
worktree-optimiser/data/projects.json    the project registry
```

Worktrees are created in a **sibling** directory, never inside the repo. A worktree
nested in its parent checkout shows up as untracked files and confuses every tool
involved.

## Verifying it works

```bash
# through the proxy, exactly as a browser would
curl -H "Host: main.localhost" http://127.0.0.1/

# or via the manager's readiness probe
curl http://localhost:7777/api/projects/<id>/worktrees/main/probe
# {"reachable":true,"status":200}
```

The probe goes through Traefik with the right Host header, so it catches both "container
is up but the server isn't listening" and "server is listening on 127.0.0.1 so the proxy
can't reach it".

## Next

- [Architecture](./architecture.md) — how the pieces fit and why
- [Configuration](./configuration.md) — environment and per-project settings
- [Troubleshooting](./troubleshooting.md) — when it doesn't work
