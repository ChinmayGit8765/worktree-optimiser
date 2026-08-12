import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
/** repo root, from either src/ (tsx) or dist/ (built) */
export const REPO_ROOT = path.resolve(here, '..', '..', '..')

export const DATA_DIR = process.env.WT_DATA_DIR ?? path.join(REPO_ROOT, 'data')
export const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json')

/** Dashboard + API. */
export const MANAGER_PORT = Number(process.env.WT_PORT ?? 7777)
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

export const LABEL = {
  managed: 'wt.managed',
  project: 'wt.project',
  branch: 'wt.branch',
  slug: 'wt.slug',
  hostPath: 'wt.hostPath',
  port: 'wt.port',
} as const

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
