import path from 'node:path'
import fs from 'node:fs/promises'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  HTTP_PORT,
  MANAGER_PORT,
  NETWORK,
  TRAEFIK_DASHBOARD_PORT,
} from './config.js'
import { candidateToConfig, detectProject } from './detect.js'
import {
  containerLogs,
  dockerReady,
  dockerVersion,
  ensureTraefik,
  followContainerLogs,
  probeThroughProxy,
  restartWorktree,
  stopWorktree,
  traefikStatus,
} from './docker.js'
import { listDir, readTextFile, resolveInside } from './files.js'
import * as git from './git.js'
import { slugify } from './slug.js'
import {
  HttpError,
  deleteProject,
  listProjects,
  requireProject,
  upsertProject,
} from './store.js'
import { ProjectConfig, type SystemStatus } from './types.js'
import {
  createWorktree,
  destroyWorktree,
  listWorktreeInfos,
  resolveWorktree,
  startWorktree,
  stopAll,
} from './worktrees.js'

// Both of these end up in container names, Docker label filters and Traefik
// router ids, so they are constrained to the shape slugify() produces rather
// than accepted as free text.
const Identifier = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase alphanumeric with hyphens')

const ProjectParams = z.object({ id: Identifier })
const WorktreeParams = z.object({ id: Identifier, slug: Identifier })

/**
 * Query strings are always strings. `z.coerce.boolean()` is wrong here — it
 * treats any non-empty value as true, so `?force=false` would delete.
 */
const QueryBool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1')

const RelPath = z.string().max(4096)

const DetectBody = z.object({ repoPath: z.string().min(1).max(4096) })

const StartBody = z
  .object({ recreate: z.boolean().default(false) })
  .nullish()
  .transform((v) => v ?? { recreate: false })

const DestroyQuery = z.object({ force: QueryBool, keepWorktree: QueryBool })

const LogsQuery = z.object({
  tail: z.coerce.number().int().min(1).max(10_000).default(400),
})

const FilesQuery = z.object({ path: RelPath.default(''), all: QueryBool })
const FileQuery = z.object({ path: RelPath.min(1) })
const DiffQuery = z.object({ base: z.string().min(1).max(255).optional() })
const PatchQuery = z.object({
  path: RelPath.min(1),
  base: z.string().min(1).max(255).optional(),
  origin: z.enum(['committed', 'working']).default('working'),
  untracked: QueryBool,
})

const CreateProjectBody = z.object({
  repoPath: z.string().min(1),
  id: z.string().optional(),
  name: z.string().optional(),
  worktreesRoot: z.string().optional(),
  /** Which detected candidate to adopt; defaults to the highest-confidence one. */
  workdir: z.string().optional(),
  overrides: ProjectConfig.partial().optional(),
})

const CreateWorktreeBody = z.object({
  branch: z.string().min(1),
  createBranch: z.boolean().default(false),
  baseRef: z.string().optional(),
  start: z.boolean().default(true),
})

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value)
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ')
    throw new HttpError(400, detail)
  }
  return result.data
}

async function assertDirectory(dir: string): Promise<string> {
  const abs = path.resolve(dir)
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(abs)
  } catch {
    throw new HttpError(400, `Path does not exist: ${abs}`)
  }
  if (!stat.isDirectory()) throw new HttpError(400, `Not a directory: ${abs}`)
  return abs
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.message })
    }
    app.log.error(err)
    const message = err instanceof Error ? err.message : String(err)
    return reply.status(500).send({ error: message || 'Internal error' })
  })

  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------

  app.get('/api/system', async (): Promise<SystemStatus> => {
    const ready = await dockerReady()
    let version: string | null = null
    let traefik: SystemStatus['traefik']['status'] = 'absent'

    if (ready.ok) {
      version = await dockerVersion().catch(() => null)
      traefik = await traefikStatus().catch(() => 'absent' as const)
    }

    return {
      dockerOk: ready.ok,
      dockerError: ready.error,
      dockerVersion: version,
      traefik: {
        status: traefik,
        httpPort: HTTP_PORT,
        dashboardUrl: `http://localhost:${TRAEFIK_DASHBOARD_PORT}/dashboard/`,
      },
      network: NETWORK,
      managerPort: MANAGER_PORT,
    }
  })

  app.post('/api/system/proxy', async () => {
    await ensureTraefik()
    return { status: await traefikStatus() }
  })

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  app.get('/api/projects', async () => ({ projects: await listProjects() }))

  app.post('/api/projects/detect', async (req: FastifyRequest) => {
    const { repoPath } = parse(DetectBody, req.body)
    const abs = await assertDirectory(repoPath)
    if (!(await git.isGitRepo(abs))) {
      throw new HttpError(400, `${abs} is not a git repository.`)
    }
    const root = await git.toplevel(abs)
    const detection = await detectProject(root)
    return {
      repoPath: root,
      suggestedId: slugify(path.basename(root)),
      suggestedWorktreesRoot: defaultWorktreesRoot(root),
      defaultBranch: await git.defaultBranch(root),
      ...detection,
    }
  })

  app.post('/api/projects', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = parse(CreateProjectBody, req.body)
    const abs = await assertDirectory(body.repoPath)
    if (!(await git.isGitRepo(abs))) {
      throw new HttpError(400, `${abs} is not a git repository.`)
    }

    const root = await git.toplevel(abs)
    const detection = await detectProject(root)
    const candidate =
      (body.workdir !== undefined
        ? detection.candidates.find((c) => c.workdir === body.workdir)
        : detection.candidates[0]) ?? detection.candidates[0]

    if (!candidate) {
      throw new HttpError(
        422,
        'Could not work out how to start this project. Supply overrides with a dev command and port.',
      )
    }

    const existing = await listProjects()
    const baseId = body.id ? slugify(body.id) : slugify(path.basename(root))
    const id = uniqueId(baseId, existing.map((p) => p.id))

    const config = ProjectConfig.parse({
      ...candidateToConfig(
        {
          id,
          name: body.name ?? path.basename(root),
          repoPath: root,
          worktreesRoot: path.resolve(body.worktreesRoot ?? defaultWorktreesRoot(root)),
        },
        detection,
        candidate,
      ),
      ...(body.overrides ?? {}),
      id,
      repoPath: root,
    })

    await upsertProject(config)
    return reply.status(201).send({ project: config })
  })

  app.patch('/api/projects/:id', async (req: FastifyRequest) => {
    const { id } = parse(ProjectParams, req.params)
    const current = await requireProject(id)
    const patch = parse(ProjectConfig.partial(), req.body)
    const next = ProjectConfig.parse({ ...current, ...patch, id: current.id })
    await upsertProject(next)
    return { project: next }
  })

  app.delete('/api/projects/:id', async (req: FastifyRequest) => {
    const { id } = parse(ProjectParams, req.params)
    await requireProject(id)
    await stopAll(id).catch(() => 0)
    const removed = await deleteProject(id)
    return { removed }
  })

  app.get('/api/projects/:id/branches', async (req: FastifyRequest) => {
    const { id } = parse(ProjectParams, req.params)
    const project = await requireProject(id)
    return {
      branches: await git.listBranches(project.repoPath),
      defaultBranch: await git.defaultBranch(project.repoPath),
    }
  })

  app.post('/api/projects/:id/fetch', async (req: FastifyRequest) => {
    const { id } = parse(ProjectParams, req.params)
    const project = await requireProject(id)
    await git.fetchAll(project.repoPath)
    return { branches: await git.listBranches(project.repoPath) }
  })

  // -------------------------------------------------------------------------
  // Worktrees
  // -------------------------------------------------------------------------

  app.get('/api/projects/:id/worktrees', async (req: FastifyRequest) => {
    const { id } = parse(ProjectParams, req.params)
    const project = await requireProject(id)
    return { worktrees: await listWorktreeInfos(project) }
  })

  app.post('/api/projects/:id/worktrees', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = parse(ProjectParams, req.params)
    const project = await requireProject(id)
    const body = parse(CreateWorktreeBody, req.body)
    const worktree = await createWorktree(project, body)
    return reply.status(201).send({ worktree })
  })

  app.post('/api/projects/:id/worktrees/:slug/start', async (req: FastifyRequest) => {
    const { id, slug } = parse(WorktreeParams, req.params)
    const project = await requireProject(id)
    const { recreate } = parse(StartBody, req.body)
    return { worktree: await startWorktree(project, slug, recreate) }
  })

  app.post('/api/projects/:id/worktrees/:slug/stop', async (req: FastifyRequest) => {
    const { id, slug } = parse(WorktreeParams, req.params)
    const project = await requireProject(id)
    await stopWorktree(project.id, slug)
    return { worktree: await resolveWorktree(project, slug) }
  })

  app.post('/api/projects/:id/worktrees/:slug/restart', async (req: FastifyRequest) => {
    const { id, slug } = parse(WorktreeParams, req.params)
    const project = await requireProject(id)
    await restartWorktree(project.id, slug)
    return { worktree: await resolveWorktree(project, slug) }
  })

  app.delete('/api/projects/:id/worktrees/:slug', async (req: FastifyRequest) => {
    const { id, slug } = parse(WorktreeParams, req.params)
    const project = await requireProject(id)
    const query = parse(DestroyQuery, req.query)
    await destroyWorktree(project, slug, {
      force: query.force,
      keepWorktree: query.keepWorktree,
    })
    return { removed: true }
  })

  app.get('/api/projects/:id/worktrees/:slug/probe', async (req: FastifyRequest) => {
    const { id, slug } = parse(WorktreeParams, req.params)
    await requireProject(id)
    const status = await probeThroughProxy(slug)
    return { reachable: status !== null, status }
  })

  // -------------------------------------------------------------------------
  // Worktree inspection (file tree + diff)
  // -------------------------------------------------------------------------

  /** Resolve a worktree to a browsable directory, rejecting orphans. */
  async function worktreeRoot(projectId: string, slug: string): Promise<string> {
    const project = await requireProject(projectId)
    const info = await resolveWorktree(project, slug)
    if (info.path === '(worktree missing)') {
      throw new HttpError(410, `The worktree directory for "${slug}" no longer exists.`)
    }
    return info.path
  }

  app.get('/api/projects/:id/worktrees/:slug/files', async (req: FastifyRequest) => {
    const { id, slug } = parse(WorktreeParams, req.params)
    const query = parse(FilesQuery, req.query)
    const root = await worktreeRoot(id, slug)
    return listDir(root, query.path, query.all)
  })

  app.get('/api/projects/:id/worktrees/:slug/file', async (req: FastifyRequest) => {
    const { id, slug } = parse(WorktreeParams, req.params)
    const query = parse(FileQuery, req.query)
    const root = await worktreeRoot(id, slug)
    return readTextFile(root, query.path)
  })

  app.get('/api/projects/:id/worktrees/:slug/diff', async (req: FastifyRequest) => {
    const { id, slug } = parse(WorktreeParams, req.params)
    const project = await requireProject(id)
    const info = await resolveWorktree(project, slug)
    if (info.path === '(worktree missing)') {
      throw new HttpError(410, `The worktree directory for "${slug}" no longer exists.`)
    }
    const query = parse(DiffQuery, req.query)
    const base = query.base || (await git.defaultBranch(project.repoPath))
    return git.diffSummary(info.path, base)
  })

  app.get('/api/projects/:id/worktrees/:slug/diff/patch', async (req: FastifyRequest) => {
    const { id, slug } = parse(WorktreeParams, req.params)
    const project = await requireProject(id)
    const info = await resolveWorktree(project, slug)
    if (info.path === '(worktree missing)') {
      throw new HttpError(410, `The worktree directory for "${slug}" no longer exists.`)
    }
    const query = parse(PatchQuery, req.query)

    // Validate the path against the worktree before handing it to git, so a
    // traversal attempt can't reach outside via `--` arguments.
    resolveInside(info.path, query.path)

    const base = query.base || (await git.defaultBranch(project.repoPath))
    const patch = await git.filePatch(
      info.path,
      base,
      query.path,
      query.origin,
      query.untracked,
    )
    return { path: query.path, origin: query.origin, base, patch }
  })

  app.get('/api/projects/:id/worktrees/:slug/logs', async (req: FastifyRequest) => {
    const { id, slug } = parse(WorktreeParams, req.params)
    await requireProject(id)
    const { tail } = parse(LogsQuery, req.query)
    return { logs: await containerLogs(id, slug, { tail }) }
  })

  // Server-sent events rather than websockets: log tailing is one-directional,
  // and SSE reconnects on its own without any client-side plumbing.
  app.get('/api/projects/:id/worktrees/:slug/logs/stream', async (req, reply) => {
    const { id, slug } = parse(WorktreeParams, req.params)
    await requireProject(id)

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const controller = new AbortController()
    const send = (text: string) => {
      for (const line of text.split(/\r?\n/)) {
        reply.raw.write(`data: ${line}\n\n`)
      }
    }

    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 20_000)
    req.raw.on('close', () => {
      clearInterval(heartbeat)
      controller.abort()
    })

    try {
      await followContainerLogs(id, slug, send, controller.signal)
    } catch (err) {
      send(`[wt] log stream ended: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearInterval(heartbeat)
      reply.raw.end()
    }
  })
}

function defaultWorktreesRoot(repoRoot: string): string {
  // Deliberately a sibling of the repo, never inside it: a worktree nested in the
  // parent checkout shows up as untracked files and confuses every tool involved.
  return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-worktrees`)
}

function uniqueId(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base}-${n}`)) n++
  return `${base}-${n}`
}
