export type RuntimeKind = 'node' | 'python' | 'static' | 'custom'

export type ContainerStatus =
  | 'running'
  | 'created'
  | 'restarting'
  | 'paused'
  | 'exited'
  | 'dead'
  | 'absent'

export interface Project {
  id: string
  name: string
  repoPath: string
  worktreesRoot: string
  runtime: RuntimeKind
  image: string
  workdir: string
  install: string | null
  dev: string
  containerPort: number
  env: Record<string, string>
  volumePaths: string[]
  watchPolling: boolean
  packageManager?: string
}

export interface Worktree {
  projectId: string
  branch: string
  slug: string
  path: string
  containerName: string
  containerId: string | null
  status: ContainerStatus
  health: string | null
  url: string
  altUrl: string
  hostPort: number | null
  localUrl: string | null
  head: string | null
  dirty: boolean
  primary: boolean
  startedAt: string | null
  exitCode: number | null
}

export interface BranchRef {
  name: string
  kind: 'local' | 'remote'
  head: string
  subject: string
  date: string
  checkedOutAt: string | null
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

export interface DirEntry {
  name: string
  path: string
  type: 'dir' | 'file'
  size: number | null
}

export interface DirListing {
  path: string
  entries: DirEntry[]
}

export interface FileContent {
  path: string
  size: number
  binary: boolean
  truncated: boolean
  content: string
}

export interface FileChange {
  path: string
  status: string
  additions: number | null
  deletions: number | null
  binary: boolean
  untracked: boolean
}

export interface DiffSummary {
  base: string
  ahead: number
  behind: number
  committed: FileChange[]
  working: FileChange[]
}

export interface AppCandidate {
  workdir: string
  label: string
  framework: string
  packageManager: string
  containerPort: number
  install: string | null
  dev: string
  env: Record<string, string>
  volumePaths: string[]
  confidence: number
}

export interface Detection {
  repoPath: string
  suggestedId: string
  suggestedWorktreesRoot: string
  defaultBranch: string
  runtime: RuntimeKind
  image: string
  isMonorepo: boolean
  candidates: AppCandidate[]
  notes: string[]
}

export interface DoctorCheck {
  id: string
  label: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
  fix?: string
}

export interface DoctorReport {
  ok: boolean
  checks: DoctorCheck[]
  platform: string
  generatedAt: string
}
