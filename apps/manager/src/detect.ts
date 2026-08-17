import fs from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_CPUS, DEFAULT_MEMORY_MB } from './config.js'
import { containerPath } from './paths.js'
import type { ProjectConfig, RuntimeKind } from './types.js'

/**
 * Best-effort inspection of a checkout so registering a repo is one click instead
 * of a form. Everything produced here is a *suggestion* the user can override —
 * we never silently guess wrong and hide it.
 */
export interface AppCandidate {
  /** Path relative to the repo root. '' = repo root. */
  workdir: string
  label: string
  framework: string
  packageManager: string
  containerPort: number
  install: string | null
  dev: string
  env: Record<string, string>
  volumePaths: string[]
  /** 0-100; highest wins as the default suggestion. */
  confidence: number
}

export interface Detection {
  runtime: RuntimeKind
  image: string
  isMonorepo: boolean
  candidates: AppCandidate[]
  notes: string[]
}

interface PackageJson {
  name?: string
  version?: string
  private?: boolean
  packageManager?: string
  engines?: { node?: string }
  workspaces?: string[] | { packages?: string[] }
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as T
  } catch {
    return null
  }
}

async function detectPackageManager(repoPath: string, pkg: PackageJson | null): Promise<string> {
  const declared = pkg?.packageManager?.split('@')[0]
  if (declared && ['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared
  if (await exists(path.join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await exists(path.join(repoPath, 'bun.lockb'))) return 'bun'
  if (await exists(path.join(repoPath, 'bun.lock'))) return 'bun'
  if (await exists(path.join(repoPath, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

function installCommand(pm: string): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm install'
    case 'yarn':
      return 'yarn install'
    case 'bun':
      return 'bun install'
    default:
      return 'npm install'
  }
}

/** Node image tag honouring engines.node / .nvmrc, falling back to a modern LTS. */
async function nodeImage(repoPath: string, pkg: PackageJson | null): Promise<string> {
  const nvmrcPath = path.join(repoPath, '.nvmrc')
  let major: string | null = null

  if (await exists(nvmrcPath)) {
    const raw = (await fs.readFile(nvmrcPath, 'utf8')).trim().replace(/^v/, '')
    const m = /^(\d+)/.exec(raw)
    if (m) major = m[1]!
  }
  if (!major && pkg?.engines?.node) {
    const m = /(\d+)/.exec(pkg.engines.node)
    if (m) major = m[1]!
  }

  // Corepack (needed for pnpm/yarn shims) ships with 18-24; don't pin outside that.
  const n = Number(major)
  const chosen = Number.isFinite(n) && n >= 18 && n <= 24 ? String(n) : '22'
  return `node:${chosen}-bookworm-slim`
}

interface FrameworkProfile {
  framework: string
  port: number
  /** Args appended to `<pm> run <script>` to force host/port binding. */
  args: (port: number) => string[]
  env?: Record<string, string>
  caches?: string[]
  confidence: number
}

/**
 * Dev servers bind to 127.0.0.1 by default, which is invisible from outside the
 * container — so every profile has to force 0.0.0.0 explicitly. That single
 * detail is the most common reason a containerised dev server "starts but 502s".
 */
function frameworkProfile(deps: Record<string, string>, hasViteConfig: boolean): FrameworkProfile {
  const has = (name: string) => name in deps

  if (has('next')) {
    return {
      framework: 'next',
      port: 3000,
      args: (p) => ['-H', '0.0.0.0', '-p', String(p)],
      caches: ['.next'],
      confidence: 95,
    }
  }
  if (has('nuxt') || has('nuxt3')) {
    return {
      framework: 'nuxt',
      port: 3000,
      args: (p) => ['--host', '0.0.0.0', '--port', String(p)],
      caches: ['.nuxt', '.output'],
      confidence: 95,
    }
  }
  if (has('@sveltejs/kit')) {
    return {
      framework: 'sveltekit',
      port: 5173,
      args: (p) => ['--host', '0.0.0.0', '--port', String(p)],
      caches: ['.svelte-kit'],
      confidence: 95,
    }
  }
  if (has('astro')) {
    return {
      framework: 'astro',
      port: 4321,
      args: (p) => ['--host', '0.0.0.0', '--port', String(p)],
      confidence: 95,
    }
  }
  if (has('@remix-run/dev')) {
    return {
      framework: 'remix',
      port: 3000,
      args: (p) => ['--host', '0.0.0.0', '--port', String(p)],
      confidence: 90,
    }
  }
  if (has('gatsby')) {
    return {
      framework: 'gatsby',
      port: 8000,
      args: (p) => ['-H', '0.0.0.0', '-p', String(p)],
      caches: ['.cache', 'public'],
      confidence: 90,
    }
  }
  if (has('@angular/cli') || has('@angular/core')) {
    return {
      framework: 'angular',
      port: 4200,
      args: (p) => ['--host', '0.0.0.0', '--port', String(p)],
      caches: ['.angular'],
      confidence: 90,
    }
  }
  if (has('react-scripts')) {
    // CRA has no host flag; it reads HOST/PORT from the environment.
    return {
      framework: 'create-react-app',
      port: 3000,
      args: () => [],
      env: { HOST: '0.0.0.0', DANGEROUSLY_DISABLE_HOST_CHECK: 'true' },
      confidence: 85,
    }
  }
  if (has('vite') || hasViteConfig) {
    return {
      framework: 'vite',
      port: 5173,
      args: (p) => ['--host', '0.0.0.0', '--port', String(p)],
      confidence: 85,
    }
  }
  if (has('@nestjs/core')) {
    return { framework: 'nestjs', port: 3000, args: () => [], confidence: 70 }
  }
  if (has('express') || has('fastify') || has('koa') || has('hono')) {
    return { framework: 'node-server', port: 3000, args: () => [], confidence: 60 }
  }
  return { framework: 'node', port: 3000, args: () => [], confidence: 40 }
}

function pickDevScript(scripts: Record<string, string>): string | null {
  for (const name of ['dev', 'start:dev', 'serve', 'start']) {
    if (scripts[name]) return name
  }
  return null
}

async function inspectNodeApp(
  repoPath: string,
  workdir: string,
  rootPm: string,
): Promise<AppCandidate | null> {
  const dir = path.join(repoPath, workdir)
  const pkg = await readJson<PackageJson>(path.join(dir, 'package.json'))
  if (!pkg) return null

  const scripts = pkg.scripts ?? {}
  const scriptName = pickDevScript(scripts)
  if (!scriptName) return null

  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const hasViteConfig =
    (await exists(path.join(dir, 'vite.config.ts'))) ||
    (await exists(path.join(dir, 'vite.config.js'))) ||
    (await exists(path.join(dir, 'vite.config.mjs')))

  const profile = frameworkProfile(deps, hasViteConfig)
  const port = profile.port
  const args = profile.args(port)
  const runArgs = args.length ? ` -- ${args.join(' ')}` : ''
  const dev = `${rootPm} run ${scriptName}${runArgs}`

  // node_modules always lives on a volume; so do framework build caches. Both are
  // write-heavy and murderously slow over a Windows bind mount.
  const volumePaths = [containerPath('/workspace', workdir, 'node_modules')]
  if (workdir !== '') volumePaths.unshift(containerPath('/workspace', 'node_modules'))
  for (const cache of profile.caches ?? []) {
    volumePaths.push(containerPath('/workspace', workdir, cache))
  }

  return {
    workdir,
    label: workdir === '' ? (pkg.name ?? 'root') : workdir,
    framework: profile.framework,
    packageManager: rootPm,
    containerPort: port,
    install: installCommand(rootPm),
    dev,
    env: { PORT: String(port), ...(profile.env ?? {}) },
    volumePaths,
    confidence: profile.confidence + (workdir === '' ? 0 : 5),
  }
}

/** Workspace globs are usually one level deep (`apps/*`); resolve those directly. */
async function workspaceDirs(repoPath: string, pkg: PackageJson | null): Promise<string[]> {
  const globs: string[] = []

  const ws = pkg?.workspaces
  if (Array.isArray(ws)) globs.push(...ws)
  else if (ws?.packages) globs.push(...ws.packages)

  const pnpmWs = path.join(repoPath, 'pnpm-workspace.yaml')
  if (await exists(pnpmWs)) {
    const raw = await fs.readFile(pnpmWs, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line)
      if (m) globs.push(m[1]!.trim())
    }
  }

  const out = new Set<string>()
  for (const glob of globs) {
    if (glob.startsWith('!')) continue
    if (glob.endsWith('/*')) {
      const base = glob.slice(0, -2)
      try {
        for (const entry of await fs.readdir(path.join(repoPath, base), { withFileTypes: true })) {
          if (entry.isDirectory()) out.add(`${base}/${entry.name}`)
        }
      } catch {
        /* glob base missing; ignore */
      }
    } else if (!glob.includes('*')) {
      out.add(glob.replace(/\/$/, ''))
    }
  }
  return [...out]
}

const FALLBACK_APP_DIRS = ['apps/web', 'apps/frontend', 'apps/client', 'web', 'frontend', 'client']

export async function detectProject(repoPath: string): Promise<Detection> {
  const notes: string[] = []
  const rootPkg = await readJson<PackageJson>(path.join(repoPath, 'package.json'))

  if (rootPkg) {
    const pm = await detectPackageManager(repoPath, rootPkg)
    const image = await nodeImage(repoPath, rootPkg)
    const dirs = await workspaceDirs(repoPath, rootPkg)
    const isMonorepo = dirs.length > 0

    const searchDirs = new Set<string>(['', ...dirs])
    if (!isMonorepo) for (const d of FALLBACK_APP_DIRS) searchDirs.add(d)

    const candidates: AppCandidate[] = []
    for (const dir of searchDirs) {
      const candidate = await inspectNodeApp(repoPath, dir, pm)
      if (candidate) candidates.push(candidate)
    }

    // A monorepo root's `dev` usually fans out to every package via turbo/nx, which
    // means several ports and nothing sensible to route. Prefer a real app dir.
    if (isMonorepo && candidates.length > 1) {
      notes.push(
        'Monorepo detected. Pick the app whose dev server you want routed — the root `dev` script normally starts several at once.',
      )
      for (const c of candidates) if (c.workdir === '') c.confidence -= 30
    }

    candidates.sort((a, b) => b.confidence - a.confidence)
    if (candidates.length === 0) {
      notes.push('No `dev`/`start` script found in package.json — set the dev command manually.')
    }
    if (pm !== 'npm') {
      notes.push(`Using ${pm}; the container enables corepack before installing.`)
    }

    return { runtime: 'node', image, isMonorepo, candidates, notes }
  }

  const pythonCandidate = await detectPython(repoPath)
  if (pythonCandidate) {
    return {
      runtime: 'python',
      image: 'python:3.12-slim',
      isMonorepo: false,
      candidates: [pythonCandidate],
      notes: ['Python project detected. Verify the dev command before starting.'],
    }
  }

  return {
    runtime: 'static',
    image: 'nginx:alpine',
    isMonorepo: false,
    candidates: [
      {
        workdir: '',
        label: 'static',
        framework: 'static',
        packageManager: 'none',
        containerPort: 80,
        install: null,
        dev: 'nginx -g "daemon off;"',
        env: {},
        volumePaths: [],
        confidence: 20,
      },
    ],
    notes: ['No package.json or Python markers found — falling back to a static nginx server.'],
  }
}

async function detectPython(repoPath: string): Promise<AppCandidate | null> {
  const hasRequirements = await exists(path.join(repoPath, 'requirements.txt'))
  const hasPyproject = await exists(path.join(repoPath, 'pyproject.toml'))
  const hasManage = await exists(path.join(repoPath, 'manage.py'))
  if (!hasRequirements && !hasPyproject && !hasManage) return null

  const install = hasRequirements
    ? 'pip install --no-cache-dir -r requirements.txt'
    : hasPyproject
      ? 'pip install --no-cache-dir -e .'
      : null

  if (hasManage) {
    return {
      workdir: '',
      label: 'django',
      framework: 'django',
      packageManager: 'pip',
      containerPort: 8000,
      install,
      dev: 'python manage.py runserver 0.0.0.0:8000',
      env: { PYTHONUNBUFFERED: '1' },
      volumePaths: [],
      confidence: 85,
    }
  }

  let framework = 'python'
  let dev = 'python -m http.server 8000'
  if (hasRequirements) {
    const reqs = (await fs.readFile(path.join(repoPath, 'requirements.txt'), 'utf8')).toLowerCase()
    if (reqs.includes('fastapi') || reqs.includes('uvicorn')) {
      framework = 'fastapi'
      dev = 'uvicorn main:app --host 0.0.0.0 --port 8000 --reload'
    } else if (reqs.includes('flask')) {
      framework = 'flask'
      dev = 'flask run --host 0.0.0.0 --port 8000'
    }
  }

  return {
    workdir: '',
    label: framework,
    framework,
    packageManager: 'pip',
    containerPort: 8000,
    install,
    dev,
    env: { PYTHONUNBUFFERED: '1', FLASK_DEBUG: '1' },
    volumePaths: [],
    confidence: 60,
  }
}

/** Fold a detection + chosen candidate into a full ProjectConfig. */
export function candidateToConfig(
  base: Pick<ProjectConfig, 'id' | 'name' | 'repoPath' | 'worktreesRoot'>,
  detection: Detection,
  candidate: AppCandidate,
): ProjectConfig {
  return {
    ...base,
    runtime: detection.runtime,
    image: detection.image,
    workdir: candidate.workdir,
    install: candidate.install,
    dev: candidate.dev,
    containerPort: candidate.containerPort,
    env: candidate.env,
    volumePaths: candidate.volumePaths,
    watchPolling: true,
    cpuLimit: DEFAULT_CPUS,
    memoryLimitMb: DEFAULT_MEMORY_MB,
    packageManager: candidate.packageManager,
  }
}
