# Troubleshooting

**Run `npm run doctor` first.** It checks Docker, ports, git, Node, hostname
resolution and Docker Desktop file sharing, and every failure it reports comes with
the fix. The same report is in the dashboard under **Doctor**.

## Wildcard localhost hostnames do not resolve (the most common one)

This is the single most likely reason the tool looks broken, and it is not a fault
in your setup.

`*.localhost` is loopback per RFC 6761, but that is a rule about *resolvers* -- and
the OS resolver generally does not implement it. Measured on Windows 11:

```
ping probe.localhost          -> could not find host
node dns.lookup(...)          -> ENOTFOUND
curl http://main.localhost/   -> could not resolve host
```

Chromium and modern Firefox special-case these hostnames internally, so the
dashboard links work in a browser while every scripted check fails. Nothing is
misconfigured.

**Use the direct URL instead.** Every worktree publishes a stable loopback port,
shown on its card and returned as `localUrl`:

```bash
curl http://127.0.0.1:31832/
```

Or the `localtest.me` hostname, which resolves through public DNS:

```bash
curl http://main.localtest.me/
```

Or set the Host header explicitly:

```bash
curl -H "Host: main.localhost" http://127.0.0.1/
```

The direct port is deterministic per branch, so it is safe to bookmark or hardcode
in a script.

## The container starts, logs look fine, the URL 502s

**The dev server is bound to `127.0.0.1`.** Inside a container that means visible to
nothing, including Traefik. This is the most common failure once hostnames resolve.

Check the logs — a dev server that's correct prints a network address:

```
➜  Local:   http://localhost:5173/
➜  Network: http://172.23.0.3:5173/      ← this line must be there
```

If `Network` is missing, the host flag didn't reach the server. Fix the `dev` command:

```bash
curl -X PATCH http://localhost:7777/api/projects/<id> \
  -H 'Content-Type: application/json' \
  -d '{"dev":"npm run dev -- --host 0.0.0.0 --port 5173"}'
```

Then **Rebuild** the worktree. Note the `--` before the flags: npm needs it to forward
arguments through to the underlying binary.

## The URL 404s instead of 502ing

Traefik answered but has no route matching that hostname.

```bash
curl -s http://localhost:8088/api/http/routers | grep -o '"rule":"[^"]*"'
```

Common causes:

- **Container isn't running.** No container, no labels, no route.
- **`containerPort` doesn't match what the server listens on.** The service label points
  at the wrong port.
- **You browsed to the wrong slug.** Check the exact URL in the dashboard — branch names
  are slugified, so `feat/ABC-123` is `feat-abc-123`.

## Hot reload stopped working

inotify events don't cross the Windows/macOS host → Linux container boundary. Watchers
register successfully and then never fire.

Confirm polling is on for the project (`watchPolling: true`), rebuild, and check the env
inside the container:

```bash
docker exec wt-<project>-<slug> env | grep -i poll
```

If polling is on and it still doesn't reload, the framework may use a watcher that reads
none of the standard variables. Set the framework's own option in its config file —
for Vite:

```js
export default defineConfig({
  server: { watch: { usePolling: true, interval: 300 } },
})
```

## `port is already allocated` on startup

Something else owns port 80.

```bash
# Windows
Get-NetTCPConnection -LocalPort 80 -State Listen
# Linux/macOS
sudo lsof -i :80
```

Usual suspects: IIS, Skype, another reverse proxy, a stray `nginx` container. Either stop
it or move Traefik:

```bash
WT_HTTP_PORT=8080 npm start
```

URLs become `http://<slug>.localhost:8080`; the dashboard updates its links automatically.

## `Docker is not reachable`

The daemon isn't running or isn't at the expected socket. Start Docker Desktop and wait
for the whale to settle — the manager retries on every dashboard poll, so no restart is
needed.

If Docker *is* running but the manager can't see it, you're probably on a non-default
context:

```bash
docker context ls
WT_DOCKER_SOCKET=//./pipe/dockerDesktopLinuxEngine npm start   # Windows
WT_DOCKER_SOCKET=/var/run/docker.sock npm start                # Linux/macOS
```

## `invalid mount path` / the container starts with an empty /workspace

Bind path conversion picked the wrong convention for your daemon.

```bash
WT_BIND_STYLE=wsl npm start    # daemon inside WSL
WT_BIND_STYLE=win npm start    # Docker Desktop on Windows
WT_BIND_STYLE=unix npm start   # Linux/macOS
```

On Docker Desktop for Windows, also check the drive is shared under
**Settings → Resources → File sharing**.

## `Branch "x" is already checked out at …`

Not a bug — git allows a branch in exactly one worktree at a time. Either use the
existing worktree, or make a new branch from it.

The **New worktree** dialog filters these out of the picker automatically; you'll only
hit this via the API.

## First start takes forever

It's a cold dependency install inside a fresh volume. Watch it with **Logs**.

Subsequent starts reuse the named `node_modules` volume and take seconds. **Rebuild**
also keeps volumes — only **Remove** discards them.

If every start is slow, `node_modules` is probably not on a volume. Check:

```bash
curl -s http://localhost:7777/api/projects/<id> | grep volumePaths
```

`volumePaths` must contain `/workspace/node_modules` (plus
`/workspace/<workdir>/node_modules` for a monorepo).

## Monorepo: "cannot find module" after a clean install

Both volumes are needed:

```json
"volumePaths": [
  "/workspace/node_modules",
  "/workspace/apps/web/node_modules"
]
```

Workspace tooling hoists most dependencies to the root but leaves symlinks and some
packages local. Missing either one produces resolution failures that look like a
corrupted install.

## A container is running for a worktree I deleted

Deleting a worktree directory outside the tool leaves the container, its volumes, and its
route behind. These appear in the dashboard as **orphaned** with
`path: "(worktree missing)"`. Hit **Remove** to clean up the container, volumes, and
git's stale metadata.

## The dashboard shows a worktree as dirty and I didn't touch it

Usually correct: the container wrote to the bind mount. A `npm install` run inside the
container creates `package-lock.json` on the host if one wasn't committed.

```bash
cd <worktree> && git status --short
```

## Stopping the manager didn't stop my dev servers

Working as designed. The manager is a control plane, not a supervisor — restarting the
API must not kill a running dev server mid-task. Stop containers from the dashboard, or:

```bash
docker ps --filter label=wt.managed=true -q | xargs docker stop
```

## Full reset

Nuclear option — removes every container, volume, and the network. Worktrees on disk and
your branches are untouched.

```bash
docker ps -a --filter label=wt.managed=true -q | xargs -r docker rm -f
docker volume ls --filter name=wt-vol- -q | xargs -r docker volume rm
docker network rm wt-net
rm -rf data/projects.json
```

## Getting more detail

```bash
WT_LOG_LEVEL=debug npm run dev
```

Traefik's own view of routes, services, and errors is at
<http://localhost:8088/dashboard/>.
