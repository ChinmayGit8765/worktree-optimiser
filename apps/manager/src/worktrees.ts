import fs from 'node:fs/promises'
import path from 'node:path'
import { ALT_DOMAIN, BASE_DOMAIN, LABEL, containerNameFor, urlFor } from './config.js'
import * as git from './git.js'
import {
  docker,
  listManagedContainers,
  normaliseStatus,
  removeWorktreeContainer,
  upWorktree,
} from './docker.js'
import { assertInsideReal, isInside } from './paths.js'
import { slugFor } from './slug.js'
import { HttpError } from './store.js'
import type { ProjectConfig, WorktreeInfo } from './types.js'

/** Everything the dashboard needs about one branch, in one object. */
export async function listWorktreeInfos(project: ProjectConfig): Promise<WorktreeInfo[]> {
  const [trees, containers] = await Promise.all([
    git.listWorktrees(project.repoPath),
    listManagedContainers(project.id),
  ])

  const branches = trees.map((t) => t.branch).filter((b): b is string => Boolean(b))
  const byName = new Map(containers.map((c) => [c.Names.find((n) => n.startsWith('/'))?.slice(1), c]))
  const seenSlugs = new Set<string>()
  const infos: WorktreeInfo[] = []

  for (const tree of trees) {
    if (tree.bare) continue
    const branch = tree.branch ?? `detached-${(tree.head ?? 'unknown').slice(0, 8)}`
    const slug = slugFor(branch, branches)
    seenSlugs.add(slug)

    const containerName = containerNameFor(project.id, slug)
    const container = byName.get(containerName)

    let head: string | null = tree.head?.slice(0, 8) ?? null
    let dirty = false
    try {
      const state = await git.workingState(tree.path)
      head = state.head ?? head
      dirty = state.dirty
    } catch {
      // Worktree dir deleted out from under git; leave the git-reported values.
    }

    infos.push({
      projectId: project.id,
      branch,
      slug,
      path: tree.path,
      containerName,
      containerId: container?.Id ?? null,
      status: container ? normaliseStatus(container.State) : 'absent',
      health: extractHealth(container?.Status),
      url: urlFor(slug, BASE_DOMAIN),
      altUrl: urlFor(slug, ALT_DOMAIN),
      head,
      dirty,
      primary: isInside(project.repoPath, tree.path) && isInside(tree.path, project.repoPath),
      startedAt: container ? new Date(container.Created * 1000).toISOString() : null,
      exitCode: null,
    })
  }

  // Containers whose worktree has been removed behind our back still hold ports,
  // volumes and a Traefik route — surface them so they can be cleaned up.
  for (const container of containers) {
    const slug = container.Labels?.[LABEL.slug]
    if (!slug || seenSlugs.has(slug)) continue
    infos.push({
      projectId: project.id,
      branch: container.Labels?.[LABEL.branch] ?? slug,
      slug,
      path: container.Labels?.[LABEL.hostPath] ?? '(worktree missing)',
      containerName: containerNameFor(project.id, slug),
      containerId: container.Id,
      status: normaliseStatus(container.State),
      health: extractHealth(container.Status),
      url: urlFor(slug, BASE_DOMAIN),
      altUrl: urlFor(slug, ALT_DOMAIN),
      head: null,
      dirty: false,
      primary: false,
      startedAt: new Date(container.Created * 1000).toISOString(),
      exitCode: null,
    })
  }

  return infos.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1
    return a.branch.localeCompare(b.branch)
  })
}

function extractHealth(status: string | undefined): string | null {
  if (!status) return null
  const m = /\(health(?:y|: ?([a-z]+))\)/.exec(status)
  if (!m) return null
  return m[1] ?? 'healthy'
}

export async function resolveWorktree(
  project: ProjectConfig,
  slug: string,
): Promise<WorktreeInfo> {
  const infos = await listWorktreeInfos(project)
  const found = infos.find((w) => w.slug === slug)
  if (!found) throw new HttpError(404, `No worktree "${slug}" in project "${project.id}"`)
  return found
}

export interface CreateWorktreeInput {
  branch: string
  createBranch?: boolean
  baseRef?: string
  /** Start the container immediately after creating the worktree. */
  start?: boolean
}

export async function createWorktree(
  project: ProjectConfig,
  input: CreateWorktreeInput,
): Promise<WorktreeInfo> {
  const branch = input.branch.trim()
  if (!branch) throw new HttpError(400, 'branch is required')

  const existing = await git.listWorktrees(project.repoPath)
  const branches = existing.map((t) => t.branch).filter((b): b is string => Boolean(b))
  const slug = slugFor(branch, [...branches, branch])
  const targetPath = path.join(project.worktreesRoot, slug)

  if (await pathExists(targetPath)) {
    throw new HttpError(409, `${targetPath} already exists — remove it or pick another branch name.`)
  }

  await fs.mkdir(project.worktreesRoot, { recursive: true })
  await git.addWorktree(project.repoPath, branch, targetPath, {
    createBranch: input.createBranch ?? false,
    baseRef: input.baseRef,
  })

  if (input.start !== false) {
    await upWorktree({ project, branch, slug, hostPath: targetPath })
  }

  return resolveWorktree(project, slug)
}

export interface DestroyOptions {
  /** Discard uncommitted changes in the worktree. */
  force?: boolean
  /** Remove only the container, leaving the worktree on disk. */
  keepWorktree?: boolean
}

export async function destroyWorktree(
  project: ProjectConfig,
  slug: string,
  opts: DestroyOptions = {},
): Promise<void> {
  const info = await resolveWorktree(project, slug)
  if (info.primary && !opts.keepWorktree) {
    throw new HttpError(
      400,
      'Refusing to remove the primary checkout. Stop its container instead.',
    )
  }

  await removeWorktreeContainer(project.id, slug, true)
  if (opts.keepWorktree) return

  if (info.path === '(worktree missing)') {
    await git.pruneWorktrees(project.repoPath)
    return
  }

  // Guard against a mis-set worktreesRoot turning a delete into a disaster. The
  // symlink-resolving variant matters here: a worktree directory that is itself a
  // link to somewhere else would otherwise pass the lexical check and hand git a
  // removal target outside the managed root.
  try {
    await assertInsideReal(project.worktreesRoot, info.path)
  } catch {
    throw new HttpError(
      400,
      `Worktree ${info.path} resolves outside ${project.worktreesRoot}; remove it manually.`,
    )
  }

  await git.removeWorktree(project.repoPath, info.path, opts.force ?? false)
  await git.pruneWorktrees(project.repoPath)
}

export async function startWorktree(
  project: ProjectConfig,
  slug: string,
  recreate = false,
): Promise<WorktreeInfo> {
  const info = await resolveWorktree(project, slug)
  await upWorktree({
    project,
    branch: info.branch,
    slug,
    hostPath: info.path,
    recreate,
  })
  return resolveWorktree(project, slug)
}

/** Remove every managed container for a project, leaving worktrees on disk. */
export async function stopAll(projectId: string): Promise<number> {
  const containers = await listManagedContainers(projectId)
  let stopped = 0
  for (const info of containers) {
    if (info.State !== 'running') continue
    await docker.getContainer(info.Id).stop({ t: 10 })
    stopped++
  }
  return stopped
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
