import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
/** repo root, from either src/ (tsx) or dist/ (built) */
export const REPO_ROOT = path.resolve(here, '..', '..', '..')

export const DATA_DIR = process.env.WT_DATA_DIR ?? path.join(REPO_ROOT, 'data')
export const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json')

/** Dashboard + API. */
export const MANAGER_PORT = Number(process.env.WT_PORT ?? 7777)

/**
 * Loopback by default, deliberately. This process deletes host directories and
 * serves file contents from any registered repo; exposing it to a network is an
 * explicit opt-in that also requires a token (enforced in index.ts).
 */
export const BIND_HOST = process.env.WT_HOST ?? '127.0.0.1'
/** Interface Traefik publishes worktree ports on. Same reasoning. */
export const PROXY_BIND_HOST = process.env.WT_HTTP_BIND ?? '127.0.0.1'
export const AUTH_TOKEN = process.env.WT_TOKEN || null

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '[::1]'
}

/** Host header values the manager will answer to. Guards against DNS rebinding. */
export const ALLOWED_HOSTS: string[] = (() => {
  const extra = process.env.WT_ALLOWED_HOSTS?.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const base = ['localhost', '127.0.0.1', '[::1]', '::1']
  if (!isLoopbackHost(BIND_HOST)) base.push(BIND_HOST.toLowerCase())
  return [...new Set([...base, ...(extra ?? [])])]
})()

/** Host port Traefik listens on; every worktree URL uses this. */
export const HTTP_PORT = Number(process.env.WT_HTTP_PORT ?? 80)
export const TRAEFIK_DASHBOARD_PORT = Number(process.env.WT_TRAEFIK_DASHBOARD_PORT ?? 8088)

export const NETWORK = process.env.WT_NETWORK ?? 'wt-net'
export const TRAEFIK_CONTAINER = 'wt-traefik'
export const TRAEFIK_IMAGE = process.env.WT_TRAEFIK_IMAGE ?? 'traefik:v3.3'

/**
 * `*.localhost` is resolved to loopback by every major browser without touching
 * the hosts file. Non-browser clients (curl on Windows, some CI tools) don't do
 * that, so every route also answers on `*.localtest.me`, a public DNS wildcard
 * pointing at 127.0.0.1.
 */
export const BASE_DOMAIN = process.env.WT_DOMAIN ?? 'localhost'
export const ALT_DOMAIN = process.env.WT_ALT_DOMAIN ?? 'localtest.me'

/**
 * Loopback port range for the per-worktree direct URLs. 31000-31999 sits above
 * the usual dev-server ports and below the ephemeral range on Windows (49152+),
 * so it collides with neither.
 */
export const PORT_RANGE: [number, number] = (() => {
  const m = /^(\d+)-(\d+)$/.exec(process.env.WT_PORT_RANGE ?? '')
  if (!m) return [31000, 31999]
  const lo = Number(m[1])
  const hi = Number(m[2])
  return hi > lo ? [lo, hi] : [31000, 31999]
})()

/**
 * Default per-container resource caps. Twelve Next dev servers with no ceiling
 * will take a laptop down; a cap turns "machine froze" into "one worktree died,
 * visibly". 0 means unlimited.
 *
 * 4GB rather than something tighter because bundlers routinely peak past 2GB and
 * an OOM mid-build looks like a mysterious crash rather than a limit.
 */
export const DEFAULT_CPUS = Number(process.env.WT_DEFAULT_CPUS ?? 2)
export const DEFAULT_MEMORY_MB = Number(process.env.WT_DEFAULT_MEMORY_MB ?? 4096)

/** Publishing a direct port per worktree can be turned off if you only want hostnames. */
export const PORT_FALLBACK = process.env.WT_PORT_FALLBACK !== 'false'

export const LABEL = {
  managed: 'wt.managed',
  project: 'wt.project',
  branch: 'wt.branch',
  slug: 'wt.slug',
  hostPath: 'wt.hostPath',
  port: 'wt.port',
  hostPort: 'wt.hostPort',
} as const

/** Direct loopback URL for a worktree, bypassing hostname resolution entirely. */
export function localUrlFor(hostPort: number): string {
  return `http://127.0.0.1:${hostPort}`
}

export function hostnameFor(slug: string, domain: string = BASE_DOMAIN): string {
  return `${slug}.${domain}`
}

export function urlFor(slug: string, domain: string = BASE_DOMAIN): string {
  const port = HTTP_PORT === 80 ? '' : `:${HTTP_PORT}`
  return `http://${hostnameFor(slug, domain)}${port}`
}

export function containerNameFor(projectId: string, slug: string): string {
  return `wt-${projectId}-${slug}`
}
