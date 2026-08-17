# MCP server

Exposes worktree-optimiser to coding agents, so Claude Code can stand a branch up,
watch it boot, read why it failed, and tear it down without a human driving the
dashboard.

It is a thin adapter over the same REST API the dashboard uses — it owns no logic of
its own, so the two cannot drift apart.

## Setup

The manager must be running; the MCP server talks to it over HTTP.

```bash
npm start          # manager on :7777, in one terminal
```

Then register the MCP server with Claude Code:

```bash
claude mcp add worktree-optimiser -- node /absolute/path/to/worktree-optimiser/apps/mcp/dist/index.js
```

Or by hand in `.mcp.json`:

```json
{
  "mcpServers": {
    "worktree-optimiser": {
      "command": "node",
      "args": ["/absolute/path/to/worktree-optimiser/apps/mcp/dist/index.js"],
      "env": {
        "WT_MANAGER_URL": "http://127.0.0.1:7777"
      }
    }
  }
}
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `WT_MANAGER_URL` | `http://127.0.0.1:7777` | Where the manager is listening |
| `WT_TOKEN` | unset | Bearer token, if the manager requires one |
| `WT_MCP_ALLOW_DESTRUCTIVE` | `false` | Register `delete_worktree` — see below |

## Tools

Eleven tools are registered by default. All are read-only or reversible.

| Tool | Effect | Notes |
| --- | --- | --- |
| `list_projects` | read | Registered repos and how each is run |
| `list_worktrees` | read | Branch, container status, both URLs, dirty flag, HEAD |
| `list_branches` | read | Local + remote; flags which already occupy a worktree |
| `probe_worktree` | read | Readiness through the proxy, as a browser sees it |
| `diagnose_worktree` | read | *Why* it is not serving, in actionable terms |
| `get_logs` | read | Structured tail: timestamps, stdout/stderr split, ANSI stripped |
| `get_diff` | read | Ahead/behind plus committed and uncommitted file lists |
| `create_worktree` | additive | Materialise a branch and start its container |
| `start_worktree` | reversible | Start or recreate a container |
| `stop_worktree` | reversible | Stop a container; deletes nothing |
| `restart_worktree` | reversible | Restart a wedged dev server |

### Destructive tools are opt-in

`delete_worktree` is **not registered** unless `WT_MCP_ALLOW_DESTRUCTIVE=true`.

An agent that can delete a worktree can destroy uncommitted work. With `force`, that
loss is unrecoverable — there is no reflog entry for changes that were never committed.
The default is therefore that the tool does not exist at all, rather than existing with
a warning in its description, because a description is not an access control.

Even with the flag set, the manager still refuses to remove the primary checkout, still
requires `force` explicitly when a worktree is dirty, and still keeps the branch.

## Typical agent loop

```
list_projects                  -> pick a project id
list_branches                  -> find a branch not already checked out
create_worktree                -> returns immediately; container is booting
probe_worktree (poll)          -> wait for status 200
   ... on failure:
diagnose_worktree              -> the named cause, not a bare 502
get_logs (stream: "stderr")    -> the actual error text
get_diff                       -> confirm the edit is where you think it is
stop_worktree                  -> when finished
```

`create_worktree` returns as soon as the container **starts**, not when the dev server
is **ready** — dependencies install asynchronously and a cold install is slow. Poll
`probe_worktree` rather than assuming.

## diagnose_worktree

`probe_worktree` says whether it works. `diagnose_worktree` says why it doesn't,
by reading `/proc/net/tcp` inside the container rather than inferring from the
proxy's response. That distinguishes cases which look identical from outside:

| Code | Meaning |
| --- | --- |
| `installing` | Cold dependency install in progress; wait |
| `not-listening` | Running, but nothing bound yet — still booting, or the dev command exited |
| `bound-to-loopback` | Listening on 127.0.0.1 only, so the proxy can never reach it |
| `port-mismatch` | Listening on a different port; the response names the right one |
| `container-exited` | Stopped, with the exit code and last stderr line |
| `oom-killed` | Exceeded its memory cap |
| `proxy-down` | The app is fine; Traefik is not running |
| `unreachable` | Listening correctly but the proxy still did not get a 200 |

Prefer it over guessing from logs — it returns the fix, not just the symptom.

## Interpreting probe results

| Result | Meaning |
| --- | --- |
| `reachable: false` | Nothing answered. Container not running, or still installing. |
| `reachable: true, status: 502` | Proxy answered, app did not. Still booting, or bound to `127.0.0.1` inside the container instead of `0.0.0.0`. |
| `reachable: true, status: 404` | No route matches. Container not running, or `containerPort` disagrees with what the dev server listens on. |
| `reachable: true, status: 200` | Serving. |

## Why `get_logs` and not the SSE stream

The manager also streams logs over SSE, which is right for a human watching a build and
wrong for an agent diagnosing a failure. `get_logs` returns a bounded array of
`{ ts, stream, text }`, with ANSI colour codes removed and stderr separable — no
parsing, no escape-sequence noise, and a predictable token cost.

## Notes

- The manager binds loopback by default, so the MCP server must run on the same machine
  unless you have deliberately exposed it with `WT_HOST` and `WT_TOKEN`.
- Registering a repository is deliberately not an MCP tool. It takes a filesystem path
  and decides how to execute code from it, which is a choice a human should make.
- Diagnostics go to stderr. stdout is the MCP transport; anything non-protocol written
  there corrupts the session.
