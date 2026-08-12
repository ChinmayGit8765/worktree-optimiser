# REST API

Base URL `http://localhost:7777`. Everything is JSON. The dashboard is a client of this
API and does nothing privileged, so anything it can do is scriptable.

CORS is open (`origin: true`) — it's a local dev tool.

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
      "head": "174f3c2d",
      "dirty": false,
      "primary": false,
      "startedAt": "2026-08-12T12:05:34.000Z",
      "exitCode": null
    }
  ]
}
```

`status` is one of `running`, `created`, `restarting`, `paused`, `exited`, `dead`,
`absent`. `absent` means the worktree exists but has no container.

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

### `GET /api/projects/:id/worktrees/:slug/probe`

```json
{ "reachable": true, "status": 200 }
```

Requests `127.0.0.1:<httpPort>` with `Host: <slug>.<domain>` — the browser's exact path
through Traefik. `reachable: false` means no response at all; a `404`/`502` with
`reachable: true` means Traefik answered but the app didn't.

### `GET /api/projects/:id/worktrees/:slug/logs?tail=400`

```json
{ "logs": "…demultiplexed container output…" }
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
