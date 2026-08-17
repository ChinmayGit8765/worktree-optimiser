import dns from 'node:dns/promises'
import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import {
  ALT_DOMAIN,
  BASE_DOMAIN,
  BIND_HOST,
  HTTP_PORT,
  MANAGER_PORT,
  PORT_FALLBACK,
  PORT_RANGE,
} from './config.js'
import { docker, findContainer } from './docker.js'
import { toBindPath } from './paths.js'
import { describePortHolder, isPortFree } from './ports.js'
import { listProjects } from './store.js'

const exec = promisify(execFile)

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface Check {
  id: string
  label: string
  status: CheckStatus
  detail: string
  /** What to actually do about it. Omitted when status is ok. */
  fix?: string
}

export interface DoctorReport {
  ok: boolean
  checks: Check[]
  platform: string
  generatedAt: string
}

const ok = (id: string, label: string, detail: string): Check => ({ id, label, status: 'ok', detail })
const warn = (id: string, label: string, detail: string, fix: string): Check => ({
  id,
  label,
  status: 'warn',
  detail,
  fix,
})
const fail = (id: string, label: string, detail: string, fix: string): Check => ({
  id,
  label,
  status: 'fail',
  detail,
  fix,
})

function parseVersion(text: string): [number, number, number] {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : [0, 0, 0]
}

function atLeast(v: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i]! > min[i]!) return true
    if (v[i]! < min[i]!) return false
  }
  return true
}

async function checkNode(): Promise<Check> {
  const v = parseVersion(process.versions.node)
  return atLeast(v, [20, 0, 0])
    ? ok('node', 'Node', `v${process.versions.node}`)
    : fail(
        'node',
        'Node',
        `v${process.versions.node} is too old`,
        'Install Node 20 or newer. The manager uses top-level await and modern fetch.',
      )
}

async function checkGit(): Promise<Check> {
  try {
    const { stdout } = await exec('git', ['--version'], { windowsHide: true })
    const v = parseVersion(stdout)
    return atLeast(v, [2, 20, 0])
      ? ok('git', 'git', stdout.trim())
      : fail(
          'git',
          'git',
          `${stdout.trim()} is too old`,
          'Install git 2.20 or newer — earlier versions lack `worktree list --porcelain`.',
        )
  } catch {
    return fail('git', 'git', 'not found on PATH', 'Install git and make sure it is on PATH.')
  }
}

async function checkDocker(): Promise<Check[]> {
  const checks: Check[] = []
  try {
    const version = (await docker.version()) as {
      Version?: string
      ApiVersion?: string
      MinAPIVersion?: string
    }
    checks.push(
      ok(
        'docker',
        'Docker daemon',
        `v${version.Version} (API ${version.ApiVersion})`,
      ),
    )

    // dockerode negotiates down, but a daemon older than the API it speaks will
    // fail on specific calls rather than at connect time — worth naming early.
    const api = parseVersion(version.ApiVersion ?? '0.0')
    if (!atLeast(api, [1, 41, 0])) {
      checks.push(
        warn(
          'docker-api',
          'Docker API version',
          `API ${version.ApiVersion} is older than 1.41`,
          'Upgrade Docker. Older APIs lack some container options this tool sets.',
        ),
      )
    }
  } catch (err) {
    checks.push(
      fail(
        'docker',
        'Docker daemon',
        `unreachable: ${err instanceof Error ? err.message : String(err)}`,
        os.platform() === 'win32'
          ? 'Start Docker Desktop and wait for it to finish starting. If it is running, check `docker context ls` and set WT_DOCKER_SOCKET.'
          : 'Start the Docker daemon (`sudo systemctl start docker`), or set WT_DOCKER_SOCKET if it is not at /var/run/docker.sock.',
      ),
    )
  }
  return checks
}

async function checkPort(
  id: string,
  label: string,
  port: number,
  expectedHolder: string | null,
): Promise<Check> {
  if (await isPortFree(port)) return ok(id, label, `port ${port} is free`)

  const holder = await describePortHolder(port)
  // Our own proxy or manager holding the port is the healthy steady state.
  if (expectedHolder) {
    return ok(id, label, `port ${port} in use by ${holder ?? 'a process'} — expected (${expectedHolder})`)
  }
  return fail(
    id,
    label,
    `port ${port} is already in use${holder ? ` by ${holder}` : ''}`,
    id === 'port-proxy'
      ? `Stop that process, or run with WT_HTTP_PORT=8080 (worktree URLs become http://<slug>.localhost:8080).`
      : `Stop that process, or run with WT_PORT=7788.`,
  )
}

/**
 * The check that matters most for a first run.
 *
 * `*.localhost` is loopback per RFC 6761, but that is a rule about *resolvers*,
 * and the OS resolver on Windows generally does not implement it — Chromium and
 * modern Firefox special-case it internally, while curl, ping and Node do not.
 * A user testing with curl concludes the tool is broken.
 */
async function checkLocalhostWildcard(): Promise<Check> {
  const probe = `wt-doctor-probe.${BASE_DOMAIN}`
  let resolves = false
  try {
    await dns.lookup(probe)
    resolves = true
  } catch {
    resolves = false
  }

  if (resolves) {
    return ok('wildcard-dns', `*.${BASE_DOMAIN} resolution`, `${probe} resolves at OS level`)
  }

  const detail =
    `${probe} does not resolve through the OS resolver. Chromium and modern Firefox ` +
    `special-case *.${BASE_DOMAIN} internally so the dashboard links still work, but ` +
    `curl, ping and other tools will not resolve them.`

  return PORT_FALLBACK
    ? warn(
        'wildcard-dns',
        `*.${BASE_DOMAIN} resolution`,
        detail,
        `No action needed for browsers. For scripts and other clients use the per-worktree ` +
          `direct URL (http://127.0.0.1:<port>, shown on each card) or the ${ALT_DOMAIN} ` +
          `hostname, which resolves through public DNS.`,
      )
    : fail(
        'wildcard-dns',
        `*.${BASE_DOMAIN} resolution`,
        detail,
        `Re-enable the port fallback (unset WT_PORT_FALLBACK=false) so each worktree also ` +
          `gets a direct 127.0.0.1 port, or add hosts-file entries per worktree.`,
      )
}

/**
 * Docker Desktop only bind-mounts paths under directories you have shared. An
 * unshared path produces a container that starts with an empty /workspace, which
 * looks like a broken dev server rather than a settings problem.
 */
async function checkFileSharing(): Promise<Check[]> {
  if (os.platform() === 'linux') return []

  const projects = await listProjects()
  if (projects.length === 0) return []

  // Needs a local image; pulling one just to run a diagnostic would be rude.
  const images = await docker.listImages().catch(() => [])
  const candidate = images.find((i) => (i.RepoTags ?? []).some((t) => t && t !== '<none>:<none>'))
  const image = candidate?.RepoTags?.find((t) => t && t !== '<none>:<none>')
  if (!image) {
    return [
      warn(
        'file-sharing',
        'Docker file sharing',
        'skipped — no local image available to test a bind mount with',
        'Run a worktree once; the check will work afterwards.',
      ),
    ]
  }

  const checks: Check[] = []
  const roots = [...new Set(projects.map((p) => p.worktreesRoot))]

  for (const root of roots) {
    const bind = toBindPath(root)
    let container
    try {
      container = await docker.createContainer({
        Image: image,
        Cmd: ['sh', '-c', 'ls /probe >/dev/null 2>&1 && echo SHARED || echo EMPTY'],
        HostConfig: { Binds: [`${bind}:/probe:ro`], AutoRemove: false },
      })
      await container.start()
      await container.wait()
      const logs = (await container.logs({ stdout: true, stderr: true })) as unknown as Buffer
      const text = logs.toString('utf8')

      checks.push(
        text.includes('SHARED')
          ? ok('file-sharing', `File sharing: ${root}`, 'bind mount works')
          : fail(
              'file-sharing',
              `File sharing: ${root}`,
              'the bind mount produced an empty directory inside the container',
              'Add this path under Docker Desktop → Settings → Resources → File sharing, then restart Docker.',
            ),
      )
    } catch (err) {
      checks.push(
        fail(
          'file-sharing',
          `File sharing: ${root}`,
          `bind mount failed: ${err instanceof Error ? err.message : String(err)}`,
          'Add the path under Docker Desktop → Settings → Resources → File sharing. ' +
            'If the path style looks wrong in the error, try WT_BIND_STYLE=wsl.',
        ),
      )
    } finally {
      if (container) await container.remove({ force: true }).catch(() => {})
    }
  }
  return checks
}

async function checkPortRange(): Promise<Check> {
  if (!PORT_FALLBACK) {
    return warn(
      'port-range',
      'Direct port fallback',
      'disabled by WT_PORT_FALLBACK=false',
      'Worktrees are reachable only by hostname. Re-enable it if *.localhost does not resolve for you.',
    )
  }
  const [lo, hi] = PORT_RANGE
  let free = 0
  // Sample rather than scanning a thousand ports.
  for (let i = 0; i < 10; i++) {
    if (await isPortFree(lo + Math.floor(((hi - lo) / 10) * i))) free++
  }
  return free > 0
    ? ok('port-range', 'Direct port range', `${lo}-${hi}, sampled ${free}/10 free`)
    : fail(
        'port-range',
        'Direct port range',
        `no free ports sampled in ${lo}-${hi}`,
        'Widen the range with WT_PORT_RANGE=32000-32999, or stop whatever is occupying it.',
      )
}

export async function runDoctor(): Promise<DoctorReport> {
  const traefik = await findContainer('wt-traefik').catch(() => null)
  const managerRunning = !(await isPortFree(MANAGER_PORT, BIND_HOST))

  const checks: Check[] = [
    await checkNode(),
    await checkGit(),
    ...(await checkDocker()),
    await checkPort('port-manager', 'Manager port', MANAGER_PORT, managerRunning ? 'this manager' : null),
    await checkPort('port-proxy', 'Proxy port', HTTP_PORT, traefik ? 'the Traefik proxy' : null),
    await checkLocalhostWildcard(),
    await checkPortRange(),
    ...(await checkFileSharing()),
  ]

  return {
    ok: checks.every((c) => c.status !== 'fail'),
    checks,
    platform: `${os.platform()} ${os.release()}`,
    generatedAt: new Date().toISOString(),
  }
}
