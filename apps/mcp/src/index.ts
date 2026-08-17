#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { MANAGER_URL, ManagerError, manager, type Worktree } from './client.js'

/**
 * MCP surface over the manager's REST API, so a coding agent can stand a branch
 * up, watch it start, read why it failed, and tear it down without a human
 * driving the dashboard.
 *
 * Destructive tools are opt-in. An agent that can delete a worktree can destroy
 * uncommitted work, so `delete_worktree` is only registered when
 * WT_MCP_ALLOW_DESTRUCTIVE=true. Everything registered by default is either
 * read-only or reversible: stopping a container loses nothing, and creating a
 * worktree only adds.
 */
const ALLOW_DESTRUCTIVE = process.env.WT_MCP_ALLOW_DESTRUCTIVE === 'true'

const server = new McpServer({
  name: 'worktree-optimiser',
  version: '0.1.0',
})

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

const ok = (data: unknown, summary?: string): ToolResult => ({
  content: [
    {
      type: 'text',
      text: summary
        ? `${summary}\n\n${JSON.stringify(data, null, 2)}`
        : JSON.stringify(data, null, 2),
    },
  ],
})

const fail = (err: unknown): ToolResult => ({
  content: [
    {
      type: 'text',
      text: err instanceof ManagerError ? err.message : `Unexpected error: ${String(err)}`,
    },
  ],
  isError: true,
})

/** Trim a worktree to what an agent actually needs, so listings stay cheap. */
const brief = (w: Worktree) => ({
  branch: w.branch,
  slug: w.slug,
  status: w.status,
  url: w.url,
  localUrl: w.localUrl,
  head: w.head,
  dirty: w.dirty,
  primary: w.primary,
  path: w.path,
})

// ---------------------------------------------------------------------------
// Read-only
// ---------------------------------------------------------------------------

server.registerTool(
  'list_projects',
  {
    title: 'List registered projects',
    description:
      'List repositories registered with worktree-optimiser. Returns each project id, ' +
      'name, repo path on disk, and the dev command used to run it. Use the id with the ' +
      'other tools.',
    inputSchema: {},
  },
  async () => {
    try {
      const projects = await manager.projects()
      if (projects.length === 0) {
        return ok(
          [],
          'No projects registered. Add one in the dashboard at ' +
            `${MANAGER_URL} (the manager cannot register a repo without a human choosing it).`,
        )
      }
      return ok(projects, `${projects.length} project(s).`)
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'list_worktrees',
  {
    title: 'List worktrees',
    description:
      "List every git worktree of a project and its container state. `status` is the " +
      "container ('running', 'exited', 'absent'), `url` is the hostname route, `localUrl` " +
      'is a direct loopback port that works regardless of *.localhost resolution, and ' +
      '`dirty` means the checkout has uncommitted changes.',
    inputSchema: {
      projectId: z.string().describe('Project id from list_projects'),
    },
  },
  async ({ projectId }) => {
    try {
      const worktrees = await manager.worktrees(projectId)
      const running = worktrees.filter((w) => w.status === 'running').length
      return ok(worktrees.map(brief), `${worktrees.length} worktree(s), ${running} running.`)
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'list_branches',
  {
    title: 'List branches',
    description:
      'List local and remote branches of a project. `checkedOutAt` is non-null when a ' +
      'branch already occupies a worktree — git allows a branch in only one worktree at a ' +
      'time, so those cannot be used for a new one.',
    inputSchema: {
      projectId: z.string().describe('Project id from list_projects'),
    },
  },
  async ({ projectId }) => {
    try {
      const { branches, defaultBranch } = await manager.branches(projectId)
      const available = branches.filter((b) => !b.checkedOutAt)
      return ok(
        { defaultBranch, branches },
        `${branches.length} branch(es), ${available.length} available for a new worktree.`,
      )
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'probe_worktree',
  {
    title: 'Check a worktree is serving',
    description:
      "Readiness check through the proxy, exactly as a browser would reach it. " +
      '`reachable: false` means nothing answered; a 502 or 404 with reachable true means ' +
      'the proxy answered but the dev server did not — usually still starting, or bound ' +
      'to 127.0.0.1 inside the container instead of 0.0.0.0. Poll this after starting.',
    inputSchema: {
      projectId: z.string(),
      slug: z.string().describe('Worktree slug from list_worktrees'),
    },
  },
  async ({ projectId, slug }) => {
    try {
      return ok(await manager.probe(projectId, slug))
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'diagnose_worktree',
  {
    title: 'Diagnose why a worktree is not serving',
    description:
      'Work out WHY a worktree is not responding, in actionable terms. Reads what the ' +
      'container is actually listening on (via /proc/net/tcp inside it) rather than guessing ' +
      'from the proxy response, so it distinguishes cases that look identical from outside: ' +
      'still installing, nothing listening yet, listening on the wrong port (names the right ' +
      'one), bound to 127.0.0.1 so the proxy can never reach it, exited, or killed for ' +
      'exceeding its memory cap. Call this instead of guessing when probe_worktree is not 200.',
    inputSchema: { projectId: z.string(), slug: z.string() },
  },
  async ({ projectId, slug }) => {
    try {
      const d = await manager.diagnose(projectId, slug)
      const summary = [
        `${d.severity.toUpperCase()}: ${d.title}`,
        d.detail,
        d.fix ? `Fix: ${d.fix}` : '',
      ]
        .filter(Boolean)
        .join('\n')
      return ok(d, summary)
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'get_logs',
  {
    title: 'Read container logs',
    description:
      'Bounded tail of a worktree container log, as structured lines with timestamps and ' +
      'stdout/stderr separated, ANSI colour codes removed. Use this to find out why a dev ' +
      'server failed to start or is returning errors.',
    inputSchema: {
      projectId: z.string(),
      slug: z.string(),
      tail: z.number().int().min(1).max(2000).default(200).describe('Number of lines'),
      stream: z
        .enum(['all', 'stdout', 'stderr'])
        .default('all')
        .describe('Filter to one stream; stderr alone is usually where failures are'),
    },
  },
  async ({ projectId, slug, tail, stream }) => {
    try {
      const { lines } = await manager.logs(projectId, slug, tail)
      const filtered = stream === 'all' ? lines : lines.filter((l) => l.stream === stream)
      return ok(filtered, `${filtered.length} line(s) from ${slug}.`)
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'get_diff',
  {
    title: 'Summarise changes on a worktree',
    description:
      'What this branch changed relative to its base: commits ahead/behind, files changed ' +
      'in commits, and uncommitted working-tree changes. Use it to confirm whether an edit ' +
      'is committed and whether the running container reflects it.',
    inputSchema: {
      projectId: z.string(),
      slug: z.string(),
      base: z.string().optional().describe('Base ref; defaults to the repo default branch'),
    },
  },
  async ({ projectId, slug, base }) => {
    try {
      const diff = await manager.diff(projectId, slug, base)
      return ok(
        diff,
        `vs ${diff.base}: ${diff.ahead} ahead, ${diff.behind} behind, ` +
          `${diff.committed.length} committed file(s), ${diff.working.length} uncommitted.`,
      )
    } catch (err) {
      return fail(err)
    }
  },
)

// ---------------------------------------------------------------------------
// Mutating but non-destructive
// ---------------------------------------------------------------------------

server.registerTool(
  'create_worktree',
  {
    title: 'Create a worktree for a branch',
    description:
      'Materialise a branch as a git worktree and start its dev server container. Returns ' +
      'immediately after the container starts — dependencies install and the server boots ' +
      'asynchronously, so poll probe_worktree until it returns 200. The first run for a ' +
      'branch is slow (cold dependency install).',
    inputSchema: {
      projectId: z.string(),
      branch: z.string().describe('Branch name; may contain slashes'),
      createBranch: z
        .boolean()
        .default(false)
        .describe('Create the branch if it exists neither locally nor on a remote'),
      baseRef: z.string().optional().describe('Start point when creating a new branch'),
      start: z.boolean().default(true).describe('Start the container after creating'),
    },
  },
  async ({ projectId, branch, createBranch, baseRef, start }) => {
    try {
      const worktree = await manager.createWorktree(projectId, {
        branch,
        createBranch,
        baseRef,
        start,
      })
      return ok(
        brief(worktree),
        start
          ? `Created ${branch}. Starting at ${worktree.url} (${worktree.localUrl}). ` +
              'Poll probe_worktree until status is 200.'
          : `Created ${branch} without starting it.`,
      )
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'start_worktree',
  {
    title: 'Start a worktree container',
    description:
      'Start (or create) the dev server container for an existing worktree. `recreate` ' +
      'rebuilds the container to pick up changed project settings; dependency volumes are ' +
      'kept, so it does not reinstall.',
    inputSchema: {
      projectId: z.string(),
      slug: z.string(),
      recreate: z.boolean().default(false),
    },
  },
  async ({ projectId, slug, recreate }) => {
    try {
      const worktree = await manager.start(projectId, slug, recreate)
      return ok(brief(worktree), `Starting ${worktree.branch}. Poll probe_worktree for readiness.`)
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'stop_worktree',
  {
    title: 'Stop a worktree container',
    description:
      'Stop the dev server container. Nothing is deleted — the worktree, its branch and its ' +
      'dependency volumes all survive, and start_worktree brings it back quickly.',
    inputSchema: { projectId: z.string(), slug: z.string() },
  },
  async ({ projectId, slug }) => {
    try {
      const worktree = await manager.stop(projectId, slug)
      return ok(brief(worktree), `Stopped ${worktree.branch}.`)
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'restart_worktree',
  {
    title: 'Restart a worktree container',
    description:
      'Restart the container. Useful when a dev server has wedged; not needed for ordinary ' +
      'code edits, which hot-reload through the bind mount.',
    inputSchema: { projectId: z.string(), slug: z.string() },
  },
  async ({ projectId, slug }) => {
    try {
      const worktree = await manager.restart(projectId, slug)
      return ok(brief(worktree), `Restarted ${worktree.branch}.`)
    } catch (err) {
      return fail(err)
    }
  },
)

// ---------------------------------------------------------------------------
// Destructive — registered only with explicit opt-in
// ---------------------------------------------------------------------------

if (ALLOW_DESTRUCTIVE) {
  server.registerTool(
    'delete_worktree',
    {
      title: 'Delete a worktree (destructive)',
      description:
        'Remove a worktree: stops and removes its container and dependency volumes, then ' +
        'deletes the checkout from disk. The BRANCH IS KEPT. `force` discards uncommitted ' +
        'changes and is required when the worktree is dirty — that work is unrecoverable. ' +
        'The primary checkout can never be removed.',
      inputSchema: {
        projectId: z.string(),
        slug: z.string(),
        force: z
          .boolean()
          .default(false)
          .describe('Discard uncommitted changes. Irreversible; check get_diff first.'),
      },
    },
    async ({ projectId, slug, force }) => {
      try {
        await manager.destroy(projectId, slug, { force })
        return ok({ removed: true, slug }, `Removed worktree ${slug}. Its branch still exists.`)
      } catch (err) {
        return fail(err)
      }
    },
  )
}

// stdout is the MCP transport; anything written there that is not a protocol
// message corrupts the session. Diagnostics must go to stderr.
console.error(
  `worktree-optimiser MCP server ready (manager: ${MANAGER_URL}, ` +
    `destructive tools: ${ALLOW_DESTRUCTIVE ? 'ENABLED' : 'disabled'})`,
)

await server.connect(new StdioServerTransport())
