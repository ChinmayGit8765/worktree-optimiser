import type {
  BranchRef,
  Detection,
  Diagnosis,
  DiffSummary,
  DirListing,
  FileContent,
  Project,
  SystemStatus,
  Worktree,
} from './types'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  const text = await res.text()
  const body = text ? (JSON.parse(text) as unknown) : {}

  if (!res.ok) {
    const message =
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed with ${res.status}`
    throw new ApiError(res.status, message)
  }
  return body as T
}

const json = (data: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(data),
})

export const api = {
  system: () => request<SystemStatus>('/api/system'),
  startProxy: () => request<{ status: string }>('/api/system/proxy', { method: 'POST' }),

  projects: () => request<{ projects: Project[] }>('/api/projects').then((r) => r.projects),
  detect: (repoPath: string) => request<Detection>('/api/projects/detect', json({ repoPath })),
  createProject: (input: {
    repoPath: string
    name?: string
    worktreesRoot?: string
    workdir?: string
  }) => request<{ project: Project }>('/api/projects', json(input)).then((r) => r.project),
  updateProject: (id: string, patch: Partial<Project>) =>
    request<{ project: Project }>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then((r) => r.project),
  deleteProject: (id: string) =>
    request<{ removed: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  branches: (id: string) =>
    request<{ branches: BranchRef[]; defaultBranch: string }>(`/api/projects/${id}/branches`),
  fetchRemote: (id: string) =>
    request<{ branches: BranchRef[] }>(`/api/projects/${id}/fetch`, { method: 'POST' }),

  worktrees: (id: string) =>
    request<{ worktrees: Worktree[] }>(`/api/projects/${id}/worktrees`).then((r) => r.worktrees),
  createWorktree: (
    id: string,
    input: { branch: string; createBranch?: boolean; baseRef?: string; start?: boolean },
  ) =>
    request<{ worktree: Worktree }>(`/api/projects/${id}/worktrees`, json(input)).then(
      (r) => r.worktree,
    ),
  start: (id: string, slug: string, recreate = false) =>
    request<{ worktree: Worktree }>(
      `/api/projects/${id}/worktrees/${slug}/start`,
      json({ recreate }),
    ).then((r) => r.worktree),
  stop: (id: string, slug: string) =>
    request<{ worktree: Worktree }>(`/api/projects/${id}/worktrees/${slug}/stop`, {
      method: 'POST',
    }).then((r) => r.worktree),
  restart: (id: string, slug: string) =>
    request<{ worktree: Worktree }>(`/api/projects/${id}/worktrees/${slug}/restart`, {
      method: 'POST',
    }).then((r) => r.worktree),
  destroy: (id: string, slug: string, opts: { force?: boolean; keepWorktree?: boolean } = {}) => {
    const params = new URLSearchParams()
    if (opts.force) params.set('force', 'true')
    if (opts.keepWorktree) params.set('keepWorktree', 'true')
    const qs = params.toString()
    return request<{ removed: boolean }>(
      `/api/projects/${id}/worktrees/${slug}${qs ? `?${qs}` : ''}`,
      { method: 'DELETE' },
    )
  },
  diagnose: (id: string, slug: string) =>
    request<Diagnosis>(`/api/projects/${id}/worktrees/${slug}/diagnose`),
  probe: (id: string, slug: string) =>
    request<{ reachable: boolean; status: number | null }>(
      `/api/projects/${id}/worktrees/${slug}/probe`,
    ),
  logsUrl: (id: string, slug: string) => `/api/projects/${id}/worktrees/${slug}/logs/stream`,

  files: (id: string, slug: string, path = '', all = false) => {
    const q = new URLSearchParams({ path })
    if (all) q.set('all', 'true')
    return request<DirListing>(`/api/projects/${id}/worktrees/${slug}/files?${q}`)
  },
  file: (id: string, slug: string, path: string) =>
    request<FileContent>(
      `/api/projects/${id}/worktrees/${slug}/file?${new URLSearchParams({ path })}`,
    ),
  diff: (id: string, slug: string, base?: string) => {
    const q = new URLSearchParams()
    if (base) q.set('base', base)
    return request<DiffSummary>(`/api/projects/${id}/worktrees/${slug}/diff?${q}`)
  },
  patch: (
    id: string,
    slug: string,
    opts: { path: string; origin: 'committed' | 'working'; untracked?: boolean; base?: string },
  ) => {
    const q = new URLSearchParams({ path: opts.path, origin: opts.origin })
    if (opts.untracked) q.set('untracked', 'true')
    if (opts.base) q.set('base', opts.base)
    return request<{ path: string; origin: string; base: string; patch: string }>(
      `/api/projects/${id}/worktrees/${slug}/diff/patch?${q}`,
    )
  },
}
