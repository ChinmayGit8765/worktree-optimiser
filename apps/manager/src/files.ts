import fs from 'node:fs/promises'
import path from 'node:path'
import { isInside } from './paths.js'
import { HttpError } from './store.js'

/**
 * Read-only browsing of a worktree. Every path the client supplies is resolved
 * against the worktree root and then checked for containment — a browser-facing
 * file API is the obvious place for a traversal bug, so the guard is central
 * rather than per-endpoint.
 */
export interface DirEntry {
  name: string
  /** Path relative to the worktree root, POSIX separators. */
  path: string
  type: 'dir' | 'file'
  size: number | null
}

/** Directories that are noise in a dev worktree. Shown only with `all=true`. */
const NOISY = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.angular',
  '.turbo',
  '.cache',
  '.vite',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
])

const MAX_FILE_BYTES = 512 * 1024

export function resolveInside(root: string, relPath: string): string {
  const cleaned = (relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (path.isAbsolute(cleaned)) {
    throw new HttpError(400, 'Path must be relative to the worktree root')
  }
  const resolved = path.resolve(root, cleaned)
  if (!isInside(root, resolved)) {
    throw new HttpError(400, 'Path escapes the worktree root')
  }
  return resolved
}

function toRel(root: string, abs: string): string {
  return path.relative(root, abs).replace(/\\/g, '/')
}

export async function listDir(
  root: string,
  relPath: string,
  showAll = false,
): Promise<{ path: string; entries: DirEntry[] }> {
  const dir = resolveInside(root, relPath)

  let dirents
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new HttpError(404, `No such directory: ${relPath || '/'}`)
    if (code === 'ENOTDIR') throw new HttpError(400, `Not a directory: ${relPath}`)
    throw err
  }

  const entries: DirEntry[] = []
  for (const dirent of dirents) {
    // .git is never browsable: in a worktree it's a pointer file, and exposing
    // object storage through a web UI has no upside.
    if (dirent.name === '.git') continue
    if (!showAll && NOISY.has(dirent.name)) continue

    const abs = path.join(dir, dirent.name)
    const isDir = dirent.isDirectory()
    let size: number | null = null
    if (!isDir) {
      try {
        size = (await fs.stat(abs)).size
      } catch {
        continue // vanished between readdir and stat
      }
    }
    entries.push({ name: dirent.name, path: toRel(root, abs), type: isDir ? 'dir' : 'file', size })
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return { path: toRel(root, dir), entries }
}

export interface FileContent {
  path: string
  size: number
  binary: boolean
  truncated: boolean
  content: string
}

export async function readTextFile(root: string, relPath: string): Promise<FileContent> {
  const abs = resolveInside(root, relPath)

  let stat
  try {
    stat = await fs.stat(abs)
  } catch {
    throw new HttpError(404, `No such file: ${relPath}`)
  }
  if (stat.isDirectory()) throw new HttpError(400, `${relPath} is a directory`)

  const handle = await fs.open(abs, 'r')
  try {
    const length = Math.min(stat.size, MAX_FILE_BYTES)
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, 0)

    // A NUL byte in the first 8KB is the same heuristic git uses.
    const probe = buf.subarray(0, Math.min(8192, length))
    const binary = probe.includes(0)

    return {
      path: toRel(root, abs),
      size: stat.size,
      binary,
      truncated: stat.size > MAX_FILE_BYTES,
      content: binary ? '' : buf.toString('utf8'),
    }
  } finally {
    await handle.close()
  }
}
