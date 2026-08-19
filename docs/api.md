# REST API

Base URL `http://localhost:7777`. Everything is JSON. The dashboard is a client of this
API and does nothing privileged, so anything it can do is scriptable.

The manager binds `127.0.0.1` only. CORS is a strict allowlist (the dashboard's own
origin and the Vite dev server), not reflective, and a Host-header allowlist rejects
anything else — a web page you visit must not be able to drive this API, and DNS
rebinding must not get around that. Set `WT_TOKEN` to additionally require
`Authorization: Bearer <token>` on every `/api/*` route. See
[configuration](./configuration.md).

## Errors

Failures return a status code and a single field:

```json
{ "error": "Branch \"main\" is already checked out at C:\\dev\\app. Git allows a branch in only one worktree at a time." }
```

| Status | Meaning |
| --- | --- |
| `400` | Validation failure, or a git command failed (message includes git's stderr) |
| `404` | Unknown project, worktree, or container |
| `409` | Branch already checked out elsewhere, or the target directory exists |
| `422` | Detection couldn't work out how to start the project |
| `500` | Unexpected |

---

## System

### `GET /api/system`

```json
{
  "dockerOk": true,
  "dockerError": null,
  "dockerVersion": "28.0.4",
  "traefik": {
    "status": "running",
    "httpPort": 80,
    "dashboardUrl": "http://localhost:8088/dashboard/"
  },
  "network": "wt-net",
  "managerPort": 7777
}
```

`dockerOk: false` sets `dockerError` to the daemon connection error. Everything else
still responds; nothing can start.

### `GET /api/system/doctor`

Environment preflight: Docker, ports, git, Node, hostname resolution, Docker Desktop
file sharing. Each check returns `status` (`ok` / `warn` / `fail`), a `detail`, and a
`fix` when it is not ok. Same data as `npm run doctor`.

### `POST /api/system/proxy`

Creates the network and starts Traefik if absent, starts it if stopped, no-ops if
already running. Returns `{ "status": "running" }`.

The manager calls this itself on boot; the endpoint exists so the dashboard can recover
without a restart if you stop Traefik manually.

---

## Projects

### `GET /api/projects`

```json
{ "projects": [ /* ProjectConfig[] */ ] }
```

### `POST /api/projects/detect`

Inspect a checkout without registering it.

```json
{ "repoPath": "C:/dev/my-app" }
```

Forward slashes are fine on Windows. Response:

```json
{
  "repoPath": "C:\\dev\\my-app",
  "suggestedId": "my-app",
  "suggestedWorktreesRoot": "C:\\dev\\my-app-worktrees",
  "defaultBranch": "main",
  "runtime": "node",
  "image": "node:22-bookworm-slim",
  "isMonorepo": false,
  "candidates": [
    {
      "workdir": "",
      "label": "my-app",
      "framework": "vite",
      "packageManager": "npm",
      "containerPort": 5173,
      "install": "npm install",
      "dev": "npm run dev -- --host 0.0.0.0 --port 5173",
      "env": { "PORT": "5173" },
      "volumePaths": ["/workspace/node_modules"],
      "confidence": 85
    }
  ],
  "notes": []
}
```

`repoPath` is normalised to the repository toplevel, so pointing at a subdirectory works.
`candidates` is sorted by confidence, highest first. `notes` carries human-readable
caveats (monorepo ambiguity, missing dev script, corepack usage).

### `POST /api/projects`

Register a repo. Runs detection server-side; you choose the candidate by `workdir`.

```json
{
  "repoPath": "C:/dev/my-app",
  "name": "my-app",
  "worktreesRoot": "C:/dev/my-app-worktrees",
  "workdir": "apps/web",
  "overrides": { "containerPort": 4000, "watchPolling": false }
}
```

Only `repoPath` is required. `overrides` is a partial `ProjectConfig` applied last, so it
wins over detection. `id` is slugified and de-duplicated against existing projects.

`201` with `{ "project": ProjectConfig }`.

### `PATCH /api/projects/:id`

Partial update; `id` is immutable. Returns `{ "project": ProjectConfig }`.

Changes affect **new** containers. Existing worktrees need a rebuild
(`POST .../start` with `recreate: true`) to pick them up.

### `DELETE /api/projects/:id`

Stops every running container for the project, then removes it from the registry.
Worktrees on disk and the branches themselves are left alone. Returns
`{ "removed": true }`.

### `GET /api/projects/:id/branches`

```json
{
  "branches": [
    {
      "name": "feature/new-header",
      "kind": "local",
      "head": "174f3c2",
      "subject": "mark feature branch",
      "date": "2026-08-12T21:58:04+10:00",
      "checkedOutAt": "C:\\dev\\my-app-worktrees\\feature-new-header"
    }
  ],
  "defaultBranch": "main"
}
```

Local and remote branches, sorted by commit date descending. A local branch shadows a
remote of the same name. `origin/HEAD` is excluded — it's an alias, not a branch.
`checkedOutAt` is non-null when the branch already occupies a worktree, which makes it
ineligible for a new one.

### `POST /api/projects/:id/fetch`

`git fetch --all --prune`, then returns the refreshed `{ "branches": [...] }`.

---

## Worktrees

### `GET /api/projects/:id/worktrees`

```json
{
  "worktrees": [
    {
      "projectId": "my-app",
      "branch": "feature/new-header",
      "slug": "feature-new-header",
      "path": "C:\\dev\\my-app-worktrees\\feature-new-header",
      "containerName": "wt-my-app-feature-new-header",
      "containerId": "4fa88d0baf3e…",
      "status": "running",
      "health": null,
      "url": "http://feature-new-header.localhost",
      "altUrl": "http://feature-new-header.localtest.me",
      "hostPort": 31700,
      "localUrl": "http://127.0.0.1:31700",
      "head": "174f3c2d",
      "dirty": false,
      "changedFiles": 0,
      "ahead": 1,
      "behind": 0,
      "lastCommit": {
        "hash": "174f3c2",
        "subject": "mark feature branch",
        "date": "2026-08-12T21:58:04+10:00"
      },
      "busy": false,
      "primary": false,
      "startedAt": "2026-08-12T12:05:34.000Z",
      "exitCode": null
    }
  ]
}
```

`status` is one of `running`, `created`, `restarting`, `paused`, `exited`, `dead`,
`absent`. `absent` means the worktree exists but has no container.

`localUrl` is a direct loopback port, deterministic per branch, that works regardless
of whether `*.localhost` resolves on your machine. `busy` is true while this process
has a create/start/rebuild in flight for that worktree.

`primary: true` marks the repo's own checkout. It's listed like any other worktree and
can be started and stopped, but never removed.

The list also includes **orphans** — containers whose worktree has been deleted behind
the tool's back. They show `path: "(worktree missing)"` and still hold volumes and a
route, so they're surfaced rather than hidden. `DELETE` cleans them up.

### `POST /api/projects/:id/worktrees`

```json
{
  "branch": "feature/new-header",
  "createBranch": false,
  "baseRef": "main",
  "start": true
}
```

| Field | Default | Behaviour |
| --- | --- | --- |
| `branch` | required | Branch to materialise |
| `createBranch` | `false` | Create it if it exists nowhere; `404` otherwise |
| `baseRef` | default branch | Start point for a newly created branch |
| `start` | `true` | Start the container immediately |

Resolution order: existing local branch → tracked from a remote (`--track -b`) → created
from `baseRef`. `201` with `{ "worktree": WorktreeInfo }`.

With `start: true` the response returns as soon as the container is *started* — the
install and dev server are still coming up. Poll `/probe` for actual readiness.

### `POST /api/projects/:id/worktrees/:slug/start`

```json
{ "recreate": false }
```

Starts an existing stopped container, or creates one if absent. `recreate: true`
destroys and rebuilds the container so it picks up changed project config — volumes are
kept, so dependencies are not reinstalled.

### `POST /api/projects/:id/worktrees/:slug/stop`

`docker stop` with a 10s grace period. Because the dev server is `exec`'d it usually
exits in about a second.

### `POST /api/projects/:id/worktrees/:slug/restart`

### `DELETE /api/projects/:id/worktrees/:slug`

| Query | Effect |
| --- | --- |
| `?force=true` | Discard uncommitted changes (required if the worktree is dirty) |
| `?keepWorktree=true` | Remove only the container and volumes, leave the checkout |

Removes the container, its named volumes, the worktree directory, then prunes git's
worktree metadata. **The branch is kept** — only the checkout goes.

Refuses to touch the primary checkout, or any path outside the project's configured
`worktreesRoot`.

### `GET /api/projects/:id/worktrees/:slug/diagnose`

Why a worktree is not serving. Reads `/proc/net/tcp` inside the container rather
than inferring from the proxy response.

```json
{
  "code": "bound-to-loopback",
  "severity": "error",
  "title": "Dev server is bound to loopback",
  "detail": "Something is listening on port 5173 inside the container, but only on 127.0.0.1...",
  "fix": "Make the dev server bind 0.0.0.0 - add --host 0.0.0.0 ...",
  "listening": [{ "address": "127.0.0.1", "port": 5173 }],
  "probeStatus": 502,
  "exitCode": null,
  "warnings": []
}
```

`code` is one of `ok`, `no-container`, `container-exited`, `oom-killed`,
`installing`, `not-listening`, `bound-to-loopback`, `port-mismatch`, `proxy-down`,
`unreachable`. `warnings` carries advisories that apply regardless of the primary
result, such as file-watch polling being disabled on a platform that needs it.

### `GET /api/projects/:id/worktrees/:slug/probe`

```json
{ "reachable": true, "status": 200 }
```

Requests `127.0.0.1:<httpPort>` with `Host: <slug>.<domain>` — the browser's exact path
through Traefik. `reachable: false` means no response at all; a `404`/`502` with
`reachable: true` means Traefik answered but the app didn't.

## Inspection

Read-only browsing of a worktree — the file tree and diff the dashboard's navigator
is built on. Every client-supplied path is resolved against the worktree root and
re-checked after symlink resolution, so a symlink inside the worktree pointing at
`C:\Windows\System32` is rejected rather than served.

All four return `410` if the worktree directory has been deleted behind the tool's
back, and `400` for a path that escapes the root.

### `GET /api/projects/:id/worktrees/:slug/files?path=&all=false`

One directory level, directories first. `path` is relative to the worktree root and
defaults to it. `.git` is never listed; `node_modules`, `dist`, `.next`, `.venv` and
similar noise are hidden unless `all=true`.

```json
{
  "path": "src",
  "entries": [
    { "name": "components", "path": "src/components", "type": "dir", "size": null },
    { "name": "main.tsx", "path": "src/main.tsx", "type": "file", "size": 412 }
  ]
}
```

### `GET /api/projects/:id/worktrees/:slug/file?path=src/main.tsx`

```json
{ "path": "src/main.tsx", "size": 412, "binary": false, "truncated": false, "content": "…" }
```

Capped at 512KB; a longer file comes back `truncated: true` with the first 512KB.
`binary` is a NUL byte in the first 8KB — the same heuristic git uses — and binary
files return empty `content` rather than mojibake.

### `GET /api/projects/:id/worktrees/:slug/diff?base=main`

What this branch changed. `base` defaults to the repo's default branch.

```json
{
  "base": "main",
  "ahead": 3,
  "behind": 12,
  "committed": [
    { "path": "src/checkout.ts", "status": "M", "additions": 84, "deletions": 12,
      "binary": false, "untracked": false }
  ],
  "working": [
    { "path": "src/cart.ts", "status": "A", "additions": null, "deletions": null,
      "binary": false, "untracked": true }
  ]
}
```

`committed` is what this branch has landed since diverging from `base`; `working` is
what is still uncommitted, untracked files included. `status` is git's letter (`A`
added, `M` modified, `D` deleted, `T` type-changed, `U` unmerged). Counts are `null`
for binary files and for untracked ones, which have nothing to diff against yet.

Rename detection is deliberately off — git renders renames in numstat with a
`src/{a => b}.ts` brace syntax that is genuinely ambiguous to parse back into a path,
so a rename shows as a delete plus an add.

### `GET /api/projects/:id/worktrees/:slug/diff/patch?path=…&origin=working`

The unified diff for one file. `origin` is `working` (default) or `committed`,
matching which array of `/diff` the file came from; pass `untracked=true` for a file
flagged as such, which is diffed against the null tree.

```json
{ "path": "src/cart.ts", "origin": "working", "base": "main", "patch": "@@ -1,4 +1,9 @@\n…" }
```

## Logs

### `GET /api/projects/:id/worktrees/:slug/logs?tail=400`

```json
{ "logs": "…demultiplexed container output…" }
```

### `GET /api/projects/:id/worktrees/:slug/logs/json?tail=200`

Structured tail for programmatic readers: timestamps, stdout/stderr separated, ANSI
stripped. No parsing required.

```json
{
  "lines": [
    { "ts": "2026-08-17T12:22:02.816Z", "stream": "stdout", "text": "VITE v6.4.3 ready in 818 ms" }
  ],
  "count": 1
}
```

### `GET /api/projects/:id/worktrees/:slug/logs/stream`

Server-sent events, one `data:` frame per line, starting from the last 200 lines. A
`: ping` comment every 20s keeps intermediaries from closing it.

```js
const es = new EventSource('/api/projects/my-app/worktrees/main/logs/stream')
es.onmessage = (e) => console.log(e.data)
```

```bash
curl -N http://localhost:7777/api/projects/my-app/worktrees/main/logs/stream
```

---

## Worked example

Register a repo, run a branch, wait for it, tear it down:

```bash
API=http://localhost:7777

curl -s -X POST $API/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"repoPath":"C:/dev/my-app"}'

curl -s -X POST $API/api/projects/my-app/worktrees \
  -H 'Content-Type: application/json' \
  -d '{"branch":"feature/checkout","createBranch":true,"baseRef":"main"}'

until curl -s $API/api/projects/my-app/worktrees/feature-checkout/probe \
      | grep -q '"status":200'; do sleep 2; done
echo "ready at http://feature-checkout.localhost"

curl -s -X DELETE "$API/api/projects/my-app/worktrees/feature-checkout?force=true"
```
