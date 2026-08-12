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
