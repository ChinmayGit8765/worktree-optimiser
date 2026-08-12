import { z } from 'zod'

/** How we run the code inside the container. Drives image + command defaults. */
export const RuntimeKind = z.enum(['node', 'python', 'static', 'custom'])
export type RuntimeKind = z.infer<typeof RuntimeKind>

/**
 * A registered repo. One project = one clone on disk; every branch we spin up
 * becomes a git worktree under `worktreesRoot` plus a container built from these
 * settings. Detection (see detect.ts) proposes these; the user can override any
 * of them from the dashboard.
 */
export const ProjectConfig = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Absolute host path to the primary checkout. */
  repoPath: z.string().min(1),
  /** Absolute host dir that holds the generated worktrees. */
  worktreesRoot: z.string().min(1),
  runtime: RuntimeKind,
  image: z.string().min(1),
  /** Sub-directory inside the worktree to run in. '' means the repo root. */
  workdir: z.string().default(''),
  /** Shell command run once before `dev`. null skips it. */
  install: z.string().nullable().default(null),
  /** Shell command that starts the long-running dev server. */
  dev: z.string().min(1),
  /** Port the dev server listens on *inside* the container. */
  containerPort: z.number().int().min(1).max(65535).default(3000),
  env: z.record(z.string()).default({}),
  /**
   * Container paths backed by named volumes instead of the host bind. Keeps
   * node_modules / build caches on native container FS, which is the difference
   * between "usable" and "unusably slow" for a Windows bind mount.
   */
  volumePaths: z.array(z.string()).default([]),
  /** Force file-watch polling. Required for hot reload across a Windows bind. */
  watchPolling: z.boolean().default(true),
  packageManager: z.string().optional(),
})
export type ProjectConfig = z.infer<typeof ProjectConfig>

export const ProjectCreateInput = ProjectConfig.partial({
  id: true,
  name: true,
  worktreesRoot: true,
  runtime: true,
  image: true,
  workdir: true,
  install: true,
  dev: true,
  containerPort: true,
  env: true,
  volumePaths: true,
  watchPolling: true,
}).extend({ repoPath: z.string().min(1) })
export type ProjectCreateInput = z.infer<typeof ProjectCreateInput>

export type ContainerStatus =
  | 'running'
  | 'created'
  | 'restarting'
  | 'paused'
  | 'exited'
  | 'dead'
  | 'absent'

/** A branch that has been materialised as a worktree, plus its live container state. */
export interface WorktreeInfo {
  projectId: string
  branch: string
  slug: string
  /** Absolute host path of the worktree. */
  path: string
  containerName: string
  containerId: string | null
  status: ContainerStatus
  /** Docker healthcheck result, when the image defines one. */
  health: string | null
  /** Primary Traefik URL. */
  url: string
  /** Fallback URL that resolves via public DNS, for tools that don't do *.localhost. */
  altUrl: string
  head: string | null
  dirty: boolean
  /** True when the worktree dir is the project's primary checkout (not removable). */
  primary: boolean
  startedAt: string | null
  exitCode: number | null
}

export interface SystemStatus {
  dockerOk: boolean
  dockerError: string | null
  dockerVersion: string | null
  traefik: {
    status: ContainerStatus
    httpPort: number
    dashboardUrl: string
  }
  network: string
  managerPort: number
}
