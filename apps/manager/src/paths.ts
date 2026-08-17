import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/**
 * Docker bind sources have to be expressed the way the *daemon* expects, which
 * is not the way Windows writes paths. Docker Desktop accepts drive-letter paths
 * with forward slashes (`C:/dev/app`) and translates them; a raw backslash path
 * gets mangled. `WT_BIND_STYLE` lets you force the other conventions if you're
 * on a non-Desktop daemon or a remote context.
 *
 *   win  -> C:/dev/app                        (Docker Desktop, default on win32)
 *   wsl  -> /mnt/c/dev/app                    (daemon running inside WSL directly)
 *   unix -> path passed through untouched     (Linux/macOS)
 */
export type BindStyle = 'win' | 'wsl' | 'unix'

export function bindStyle(): BindStyle {
  const forced = process.env.WT_BIND_STYLE as BindStyle | undefined
  if (forced === 'win' || forced === 'wsl' || forced === 'unix') return forced
  return os.platform() === 'win32' ? 'win' : 'unix'
}

/** Convert an absolute host path into a Docker-acceptable bind source. */
export function toBindPath(hostPath: string, style: BindStyle = bindStyle()): string {
  const abs = path.resolve(hostPath)
  if (style === 'unix') return abs

  const m = /^([A-Za-z]):[\\/](.*)$/.exec(abs)
  if (!m) return abs.replace(/\\/g, '/')

  const drive = m[1]!
  const rest = m[2]!.replace(/\\/g, '/')
  return style === 'wsl'
    ? `/mnt/${drive.toLowerCase()}/${rest}`
    : `${drive.toUpperCase()}:/${rest}`
}

/** The docker socket bind source. Windows needs the leading double slash to dodge MSYS path conversion. */
export function dockerSocketBind(): string {
  return os.platform() === 'win32'
    ? '//var/run/docker.sock:/var/run/docker.sock:ro'
    : '/var/run/docker.sock:/var/run/docker.sock:ro'
}

/** Join a container-side path. Always POSIX, regardless of host OS. */
export function containerPath(...parts: string[]): string {
  const joined = parts
    .filter((p) => p !== '' && p !== '.')
    .join('/')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
  return joined.startsWith('/') ? joined : `/${joined}`
}

/**
 * True when `child` is inside `parent` (or equal), comparing paths only.
 *
 * `rel.startsWith('..')` is not sufficient in either direction: it wrongly
 * rejects a legitimate entry named `..hidden` (relative path `..hidden`), and it
 * is a string test on a value that must be compared as path segments. The check
 * is therefore `rel === '..'` or a `..` followed by a separator.
 *
 * This is a *lexical* check and does not follow symlinks. Anything that then
 * touches the filesystem must use `assertInsideReal`.
 */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  if (rel === '..') return false
  return !rel.startsWith(`..${path.sep}`) && !rel.startsWith('../')
}

/**
 * Reject inputs that look relative but are not, before they reach path.resolve.
 *
 * On Windows `C:foo` is *drive-relative*: it resolves against the current
 * directory of drive C:, not against the path you joined it to, so it escapes a
 * containment check that assumed a plain relative segment. `\\server\share` and
 * a leading separator are likewise absolute in effect.
 */
export function isSuspiciousRelative(input: string): boolean {
  if (input === '') return false
  if (/^[A-Za-z]:/.test(input)) return true // C:foo and C:\foo
  if (/^[\\/]{2}/.test(input)) return true // UNC \\server\share
  if (/^[\\/]/.test(input)) return true // rooted
  if (input.includes('\0')) return true // NUL truncation
  return false
}

/**
 * Containment that survives symlinks. A symlink *inside* the worktree pointing at
 * C:\Windows passes the lexical check — its path really is inside — so both ends
 * are resolved to their real locations before comparing.
 *
 * Returns the real, verified child path. Throws if it escapes.
 */
export async function assertInsideReal(parent: string, child: string): Promise<string> {
  if (!isInside(parent, child)) {
    throw new Error(`Path escapes ${parent}`)
  }

  const realParent = await fs.realpath(path.resolve(parent))

  const realChild = await realpathOfNearestAncestor(path.resolve(child))

  if (!isInside(realParent, realChild)) {
    throw new Error(`Path escapes ${parent} after resolving symlinks`)
  }
  return realChild
}

/**
 * realpath, tolerating a target that doesn't exist yet.
 *
 * Only the *existing* prefix of a path can contain a symlink, so resolving the
 * nearest existing ancestor and re-attaching the remainder is equivalent to
 * resolving the whole thing — and it works for paths several levels deep that
 * have not been created. Resolving only one level up (the previous approach)
 * failed with ENOENT whenever the immediate parent was also missing.
 */
async function realpathOfNearestAncestor(target: string): Promise<string> {
  const segments: string[] = []
  let current = target

  for (;;) {
    try {
      const real = await fs.realpath(current)
      return segments.length ? path.join(real, ...segments.reverse()) : real
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const parent = path.dirname(current)
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return target
      segments.push(path.basename(current))
      current = parent
    }
  }
}
