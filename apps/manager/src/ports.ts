import net from 'node:net'
import { PORT_RANGE, PROXY_BIND_HOST } from './config.js'

/**
 * Every worktree gets a published loopback port in addition to its Traefik
 * hostname.
 *
 * The hostname is the nicer URL, but `*.localhost` resolution is not universal:
 * Chromium resolves it, other browsers and non-browser clients historically do
 * not, and it is the single most likely reason a new user concludes the tool is
 * broken. A plain `http://127.0.0.1:<port>` always works, so it is the fallback
 * that makes the hostname optional rather than load-bearing.
 *
 * Allocation is deterministic in the branch identity, so a port survives a
 * restart and stays bookmarkable. It is stored as a container label and an
 * actual published port — nothing new is persisted, keeping the "state is
 * re-derived from docker ps" invariant intact.
 */

/** FNV-1a over the container identity; the same input always starts at the same port. */
function preferredPort(key: string): number {
  const [start, end] = PORT_RANGE
  const span = Math.max(1, end - start + 1)
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return start + (h % span)
}

/** True when nothing is listening and we may bind. */
export function isPortFree(port: number, host = PROXY_BIND_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    // exclusive stops us reporting a port as free when another socket has it
    // bound with SO_REUSEADDR, which Docker's proxy does.
    server.listen({ port, host, exclusive: true })
  })
}

export interface AllocateOptions {
  /** Stable identity for the worktree, e.g. `${projectId}/${slug}`. */
  key: string
  /** Ports already claimed by other managed containers, running or stopped. */
  reserved: Iterable<number>
}

/**
 * Deterministic first choice, then a linear probe. Probing wraps within the
 * configured range and gives up rather than silently escaping it.
 */
export async function allocatePort(opts: AllocateOptions): Promise<number> {
  const [start, end] = PORT_RANGE
  const span = end - start + 1
  const reserved = new Set(opts.reserved)
  const first = preferredPort(opts.key)

  for (let i = 0; i < span; i++) {
    const port = start + (((first - start + i) % span) + span) % span
    if (reserved.has(port)) continue
    if (await isPortFree(port)) return port
  }

  throw new Error(
    `No free port in range ${start}-${end}. Widen it with WT_PORT_RANGE, or stop some worktrees.`,
  )
}

/** Which process holds a port, for diagnostics. Best effort; null when unknown. */
export async function describePortHolder(port: number): Promise<string | null> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)

  try {
    if (process.platform === 'win32') {
      const { stdout } = await exec('netstat', ['-ano'], { windowsHide: true })
      const line = stdout
        .split(/\r?\n/)
        .find((l) => /LISTENING/.test(l) && new RegExp(`[:.]${port}\\s`).test(l))
      const pid = line?.trim().split(/\s+/).pop()
      if (!pid) return null
      const { stdout: tasks } = await exec('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
        windowsHide: true,
      })
      const name = tasks.split(',')[0]?.replace(/"/g, '').trim()
      return name ? `${name} (pid ${pid})` : `pid ${pid}`
    }
    const { stdout } = await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fcp'])
    const pid = /^p(\d+)/m.exec(stdout)?.[1]
    const cmd = /^c(.+)$/m.exec(stdout)?.[1]
    if (!pid) return null
    return cmd ? `${cmd} (pid ${pid})` : `pid ${pid}`
  } catch {
    return null
  }
}
