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

/** True when `child` is inside `parent` (or equal). Used to guard destructive ops. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
