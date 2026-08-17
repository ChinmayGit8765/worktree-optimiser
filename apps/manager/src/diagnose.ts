import os from 'node:os'
import { containerNameFor } from './config.js'
import {
  containerLogsStructured,
  demuxDockerStream,
  findContainer,
  probeThroughProxy,
  traefikStatus,
} from './docker.js'
import type { ProjectConfig } from './types.js'

/**
 * A 502 tells you nothing you can act on. This works out *why* by looking at what
 * the container is actually doing, rather than inferring it from the proxy's
 * response.
 *
 * The load-bearing trick is reading /proc/net/tcp inside the container: it says
 * exactly which addresses and ports have a listener, which distinguishes "still
 * starting" from "listening on the wrong port" from "bound to loopback so the
 * proxy can never reach it" — three problems with completely different fixes that
 * all present identically from outside.
 */

export type DiagnosisCode =
  | 'ok'
  | 'no-container'
  | 'container-exited'
  | 'oom-killed'
  | 'installing'
  | 'not-listening'
  | 'bound-to-loopback'
  | 'port-mismatch'
  | 'proxy-down'
  | 'unreachable'

export interface Listener {
  address: string
  port: number
}

export interface Diagnosis {
  code: DiagnosisCode
  severity: 'ok' | 'warn' | 'error'
  title: string
  detail: string
  fix?: string
  listening: Listener[]
  probeStatus: number | null
  exitCode: number | null
  /** Non-blocking advisories that apply regardless of the primary diagnosis. */
  warnings: Array<{ code: string; title: string; detail: string; fix: string }>
}

/** Little-endian hex in /proc/net/tcp: "0100007F" is 127.0.0.1. */
function parseIPv4(hex: string): string {
  const n = parseInt(hex, 16)
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff].join('.')
}

function parseIPv6(hex: string): string {
  if (/^0{32}$/.test(hex)) return '::'
  if (hex.toUpperCase() === '00000000000000000000000001000000') return '::1'
  return `[${hex.toLowerCase()}]`
}

export function parseProcNetTcp(text: string): Listener[] {
  const out: Listener[] = []
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    // sl local_address rem_address st ...
    if (parts.length < 4 || !/^\d+:$/.test(parts[0] ?? '')) continue
    const local = parts[1] ?? ''
    const state = parts[3] ?? ''
    if (state !== '0A') continue // 0A = TCP_LISTEN

    const [addrHex, portHex] = local.split(':')
    if (!addrHex || !portHex) continue
    const port = parseInt(portHex, 16)
    if (!Number.isInteger(port)) continue

    const address = addrHex.length === 8 ? parseIPv4(addrHex) : parseIPv6(addrHex)
    out.push({ address, port })
  }
  return out
}

const ANY_ADDRESSES = new Set(['0.0.0.0', '::'])
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1'])

async function listenersInside(containerName: string): Promise<Listener[] | null> {
  const container = await findContainer(containerName)
  if (!container) return null
  try {
    const exec = await container.exec({
      Cmd: ['cat', '/proc/net/tcp', '/proc/net/tcp6'],
      AttachStdout: true,
      AttachStderr: true,
    })
    const stream = await exec.start({ hijack: true, stdin: false })

    const chunks: Buffer[] = []
    await new Promise<void>((resolve) => {
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', resolve)
      stream.on('error', () => resolve())
    })

    return parseProcNetTcp(demuxDockerStream(Buffer.concat(chunks)))
  } catch {
    // Distroless or scratch images may have neither cat nor /proc mounted.
    return null
  }
}

const INSTALL_MARKERS = [
  'installing dependencies',
  'npm install',
  'pnpm install',
  'yarn install',
  'added ',
  'reused ',
  'Resolving packages',
  'Downloading',
]

export async function diagnoseWorktree(
  project: ProjectConfig,
  slug: string,
): Promise<Diagnosis> {
  const containerName = containerNameFor(project.id, slug)
  const warnings: Diagnosis['warnings'] = []

  // Applies whatever else is true: without polling, edits silently never reload.
  if (!project.watchPolling && os.platform() !== 'linux') {
    warnings.push({
      code: 'watch-polling-disabled',
      title: 'Hot reload will not work',
      detail:
        'File-watch polling is disabled, but inotify events do not cross the host to ' +
        'container boundary on this platform. Watchers will register and never fire.',
      fix: 'Set watchPolling: true on the project, then rebuild the worktree.',
    })
  }

  const base = { listening: [] as Listener[], probeStatus: null, exitCode: null, warnings }

  const container = await findContainer(containerName)
  if (!container) {
    return {
      ...base,
      code: 'no-container',
      severity: 'error',
      title: 'No container',
      detail: `Nothing is running for ${slug}.`,
      fix: 'Start the worktree.',
    }
  }

  const info = await container.inspect()

  if (!info.State.Running) {
    const exitCode = info.State.ExitCode ?? null
    const oom = info.State.OOMKilled === true || exitCode === 137

    const logs = await containerLogsStructured(project.id, slug, { tail: 40 }).catch(() => [])
    const lastError = [...logs].reverse().find((l) => l.stream === 'stderr')?.text

    if (oom) {
      return {
        ...base,
        exitCode,
        code: 'oom-killed',
        severity: 'error',
        title: 'Killed for exceeding its memory cap',
        detail:
          `The container hit its ${project.memoryLimitMb}MB limit and was killed ` +
          `(exit ${exitCode}). Bundlers routinely peak well above their steady-state usage.`,
        fix: `Raise memoryLimitMb for this project, or set it to 0 to remove the cap.`,
      }
    }

    return {
      ...base,
      exitCode,
      code: 'container-exited',
      severity: 'error',
      title: `Container exited (${exitCode})`,
      detail: lastError
        ? `Last stderr: ${lastError.slice(0, 300)}`
        : 'The dev server stopped. There is no restart policy, so it stays stopped and visible.',
      fix: 'Read the full logs, fix the cause, then start it again.',
    }
  }

  const probeStatus = await probeThroughProxy(slug)
  if (probeStatus === 200) {
    return {
      ...base,
      probeStatus,
      code: 'ok',
      severity: 'ok',
      title: 'Serving',
      detail: `Reachable through the proxy on port ${project.containerPort}.`,
    }
  }

  const listening = (await listenersInside(containerName)) ?? []
  const onExpected = listening.filter((l) => l.port === project.containerPort)
  const externallyReachable = onExpected.some((l) => ANY_ADDRESSES.has(l.address))
  const onlyLoopback =
    onExpected.length > 0 && onExpected.every((l) => LOOPBACK_ADDRESSES.has(l.address))

  if (onlyLoopback) {
    return {
      ...base,
      listening,
      probeStatus,
      code: 'bound-to-loopback',
      severity: 'error',
      title: 'Dev server is bound to loopback',
      detail:
        `Something is listening on port ${project.containerPort} inside the container, but only ` +
        `on ${onExpected.map((l) => l.address).join(', ')}. Inside a container that is visible ` +
        'to nothing, so the proxy cannot reach it.',
      fix:
        'Make the dev server bind 0.0.0.0 — add --host 0.0.0.0 (or -H 0.0.0.0 for Next/Gatsby) ' +
        'to the dev command, then rebuild. Note npm needs `--` before forwarded flags.',
    }
  }

  if (!externallyReachable && listening.length > 0) {
    const others = listening.filter(
      (l) => ANY_ADDRESSES.has(l.address) && l.port !== project.containerPort,
    )
    if (others.length > 0) {
      const suggestion = others[0]!.port
      return {
        ...base,
        listening,
        probeStatus,
        code: 'port-mismatch',
        severity: 'error',
        title: `Listening on ${suggestion}, but routed to ${project.containerPort}`,
        detail:
          `Nothing is listening on ${project.containerPort}, but the container has a listener on ` +
          `${others.map((l) => l.port).join(', ')}. The Traefik service label points at the wrong port.`,
        fix: `Set containerPort to ${suggestion} on the project, then rebuild the worktree.`,
      }
    }
  }

  if (listening.length === 0 || !externallyReachable) {
    const logs = await containerLogsStructured(project.id, slug, { tail: 30 }).catch(() => [])
    const recent = logs.map((l) => l.text).join('\n')
    const installing = INSTALL_MARKERS.some((m) => recent.toLowerCase().includes(m.toLowerCase()))

    return {
      ...base,
      listening,
      probeStatus,
      code: installing ? 'installing' : 'not-listening',
      severity: installing ? 'warn' : 'error',
      title: installing ? 'Still installing dependencies' : 'Nothing is listening yet',
      detail: installing
        ? 'A cold dependency install is in progress. The first run for a branch is slow; ' +
          'later starts reuse the cached volume.'
        : `The container is running but has no listener on port ${project.containerPort}. ` +
          'It is either still booting or the dev command exited without binding.',
      fix: installing ? 'Wait and re-check; watch progress in the logs.' : 'Check the logs for a startup error.',
    }
  }

  if ((await traefikStatus()) !== 'running') {
    return {
      ...base,
      listening,
      probeStatus,
      code: 'proxy-down',
      severity: 'error',
      title: 'The proxy is not running',
      detail: 'The dev server is listening correctly, but Traefik is not up to route to it.',
      fix: 'Start the proxy from the dashboard, or use the direct loopback URL.',
    }
  }

  return {
    ...base,
    listening,
    probeStatus,
    code: 'unreachable',
    severity: 'error',
    title: `Proxy returned ${probeStatus ?? 'no response'}`,
    detail:
      `The dev server is listening on 0.0.0.0:${project.containerPort}, but the proxy did not ` +
      'return 200. The app itself may be erroring, or rejecting the Host header.',
    fix:
      'Check the logs. Some frameworks reject unknown hosts — allow the worktree hostname ' +
      '(for Vite, server.allowedHosts).',
  }
}
