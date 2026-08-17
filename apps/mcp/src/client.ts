/**
 * Thin REST client for the manager. The MCP server deliberately owns no logic of
 * its own — it is an adapter over the same API the dashboard uses, so the two can
 * never drift apart or disagree about what a worktree is.
 */

export const MANAGER_URL = (process.env.WT_MANAGER_URL ?? 'http://127.0.0.1:7777').replace(
  /\/+$/,
  '',
)
const TOKEN = process.env.WT_TOKEN || null

export class ManagerError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ManagerError'
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${MANAGER_URL}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...init?.headers,
      },
    })
  } catch (err) {
    throw new ManagerError(
      0,
      `Cannot reach the worktree-optimiser manager at ${MANAGER_URL}. ` +
        `Start it with \`npm start\` in the repo, or set WT_MANAGER_URL. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    )
  }

  const text = await res.text()
  const body: unknown = text ? JSON.parse(text) : {}

  if (!res.ok) {
    const message =
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed with ${res.status}`
    throw new ManagerError(res.status, message)
  }
  return body as T
}

const post = (data?: unknown): RequestInit => ({
  method: 'POST',
  ...(data === undefined ? {} : { body: JSON.stringify(data) }),
})

export interface Worktree {
  projectId: string
  branch: string
  slug: string
  path: string
  status: string
  url: string
  altUrl: string
  hostPort: number | null
  localUrl: string | null
  head: string | null
  dirty: boolean
  primary: boolean
}

export interface Project {
  id: string
  name: string
  repoPath: string
  workdir: string
  dev: string
  containerPort: number
}

export interface LogLine {
  ts: string | null
  stream: 'stdout' | 'stderr'
  text: string
}

export interface FileChange {
  path: string
  status: string
  additions: number | null
  deletions: number | null
  untracked: boolean
}

export const manager = {
  system: () => call<Record<string, unknown>>('/api/system'),

  projects: () => call<{ projects: Project[] }>('/api/projects').then((r) => r.projects),

  worktrees: (projectId: string) =>
    call<{ worktrees: Worktree[] }>(`/api/projects/${projectId}/worktrees`).then(
      (r) => r.worktrees,
    ),

  branches: (projectId: string) =>
    call<{ branches: Array<{ name: string; kind: string; head: string; checkedOutAt: string | null }>; defaultBranch: string }>(
      `/api/projects/${projectId}/branches`,
    ),

  createWorktree: (
    projectId: string,
    body: { branch: string; createBranch?: boolean; baseRef?: string; start?: boolean },
  ) =>
    call<{ worktree: Worktree }>(`/api/projects/${projectId}/worktrees`, post(body)).then(
      (r) => r.worktree,
    ),

  start: (projectId: string, slug: string, recreate = false) =>
    call<{ worktree: Worktree }>(
      `/api/projects/${projectId}/worktrees/${slug}/start`,
      post({ recreate }),
    ).then((r) => r.worktree),

  stop: (projectId: string, slug: string) =>
    call<{ worktree: Worktree }>(`/api/projects/${projectId}/worktrees/${slug}/stop`, post()).then(
      (r) => r.worktree,
    ),

  restart: (projectId: string, slug: string) =>
    call<{ worktree: Worktree }>(
      `/api/projects/${projectId}/worktrees/${slug}/restart`,
      post(),
    ).then((r) => r.worktree),

  destroy: (projectId: string, slug: string, opts: { force?: boolean } = {}) => {
    const q = opts.force ? '?force=true' : ''
    return call<{ removed: boolean }>(`/api/projects/${projectId}/worktrees/${slug}${q}`, {
      method: 'DELETE',
    })
  },

  diagnose: (projectId: string, slug: string) =>
    call<{
      code: string
      severity: string
      title: string
      detail: string
      fix?: string
      listening: Array<{ address: string; port: number }>
      probeStatus: number | null
      exitCode: number | null
      warnings: Array<{ code: string; title: string; detail: string; fix: string }>
    }>(`/api/projects/${projectId}/worktrees/${slug}/diagnose`),

  probe: (projectId: string, slug: string) =>
    call<{ reachable: boolean; status: number | null }>(
      `/api/projects/${projectId}/worktrees/${slug}/probe`,
    ),

  logs: (projectId: string, slug: string, tail: number) =>
    call<{ lines: LogLine[]; count: number }>(
      `/api/projects/${projectId}/worktrees/${slug}/logs/json?tail=${tail}`,
    ),

  diff: (projectId: string, slug: string, base?: string) =>
    call<{
      base: string
      ahead: number
      behind: number
      committed: FileChange[]
      working: FileChange[]
    }>(
      `/api/projects/${projectId}/worktrees/${slug}/diff${base ? `?base=${encodeURIComponent(base)}` : ''}`,
    ),
}
