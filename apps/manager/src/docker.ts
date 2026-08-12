import { request as httpRequest } from 'node:http'
import Docker from 'dockerode'
import type { Container, ContainerInfo } from 'dockerode'
import {
  ALT_DOMAIN,
  BASE_DOMAIN,
  HTTP_PORT,
  LABEL,
  NETWORK,
  TRAEFIK_CONTAINER,
  TRAEFIK_DASHBOARD_PORT,
  TRAEFIK_IMAGE,
  containerNameFor,
  hostnameFor,
} from './config.js'
import { containerPath, dockerSocketBind, toBindPath } from './paths.js'
import { HttpError } from './store.js'
import type { ContainerStatus, ProjectConfig } from './types.js'

export const docker = new Docker(
  process.env.WT_DOCKER_SOCKET ? { socketPath: process.env.WT_DOCKER_SOCKET } : undefined,
)

export async function dockerVersion(): Promise<string> {
  const info = (await docker.version()) as { Version?: string }
  return info.Version ?? 'unknown'
}

export async function dockerReady(): Promise<{ ok: boolean; error: string | null }> {
  try {
    await docker.ping()
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Network + proxy
// ---------------------------------------------------------------------------

export async function ensureNetwork(): Promise<void> {
  const networks = await docker.listNetworks({ filters: { name: [NETWORK] } })
  if (networks.some((n) => n.Name === NETWORK)) return
  await docker.createNetwork({ Name: NETWORK, Driver: 'bridge' })
}

/**
 * Traefik watches the Docker socket and builds routes from container labels, so
 * a worktree becomes reachable the moment its container starts — no config
 * reload, no port bookkeeping. The same label shape maps onto a k8s Ingress later.
 */
export async function ensureTraefik(): Promise<void> {
  await ensureNetwork()

  const existing = await findContainer(TRAEFIK_CONTAINER)
  if (existing) {
    const info = await existing.inspect()
    if (info.State.Running) return
    await existing.start()
    return
  }

  await ensureImage(TRAEFIK_IMAGE)
  const container = await docker.createContainer({
    name: TRAEFIK_CONTAINER,
    Image: TRAEFIK_IMAGE,
    Cmd: [
      '--providers.docker=true',
      '--providers.docker.exposedbydefault=false',
      `--providers.docker.network=${NETWORK}`,
      '--entrypoints.web.address=:80',
      '--api.dashboard=true',
      '--api.insecure=true',
      '--log.level=INFO',
      '--accesslog=true',
    ],
    Labels: { [LABEL.managed]: 'true', 'wt.role': 'proxy' },
    ExposedPorts: { '80/tcp': {}, '8080/tcp': {} },
    HostConfig: {
      Binds: [dockerSocketBind()],
      PortBindings: {
        '80/tcp': [{ HostPort: String(HTTP_PORT) }],
        '8080/tcp': [{ HostPort: String(TRAEFIK_DASHBOARD_PORT) }],
      },
      RestartPolicy: { Name: 'unless-stopped' },
    },
    NetworkingConfig: { EndpointsConfig: { [NETWORK]: {} } },
  })
  await container.start()
}

export async function traefikStatus(): Promise<ContainerStatus> {
  const container = await findContainer(TRAEFIK_CONTAINER)
  if (!container) return 'absent'
  const info = await container.inspect()
  return normaliseStatus(info.State.Status)
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const pullsInFlight = new Map<string, Promise<void>>()

export async function ensureImage(image: string, onProgress?: (line: string) => void): Promise<void> {
  const images = await docker.listImages({ filters: { reference: [image] } })
  if (images.length > 0) return

  const existing = pullsInFlight.get(image)
  if (existing) return existing

  const pull = new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err)
      docker.modem.followProgress(
        stream,
        (doneErr: Error | null) => (doneErr ? reject(doneErr) : resolve()),
        (event: { status?: string; progress?: string }) => {
          if (onProgress && event.status) {
            onProgress(`${event.status}${event.progress ? ` ${event.progress}` : ''}`)
          }
        },
      )
    })
  }).finally(() => pullsInFlight.delete(image))

  pullsInFlight.set(image, pull)
  return pull
}

// ---------------------------------------------------------------------------
// Worktree containers
// ---------------------------------------------------------------------------

export async function findContainer(name: string): Promise<Container | null> {
  const list = await docker.listContainers({ all: true, filters: { name: [`^/${name}$`] } })
  const match = list.find((c) => c.Names.includes(`/${name}`))
  return match ? docker.getContainer(match.Id) : null
}

export async function listManagedContainers(projectId?: string): Promise<ContainerInfo[]> {
  const filters: Record<string, string[]> = { label: [`${LABEL.managed}=true`] }
  if (projectId) filters.label!.push(`${LABEL.project}=${projectId}`)
  const list = await docker.listContainers({ all: true, filters })
  return list.filter((c) => c.Labels?.['wt.role'] !== 'proxy')
}

export function normaliseStatus(status: string | undefined): ContainerStatus {
  switch (status) {
    case 'running':
    case 'created':
    case 'restarting':
    case 'paused':
    case 'exited':
    case 'dead':
      return status
    default:
      return 'absent'
  }
}

function volumeNameFor(projectId: string, slug: string, mountPath: string): string {
  const suffix = mountPath.replace(/^\/workspace\/?/, '').replace(/[^a-zA-Z0-9]+/g, '-') || 'root'
  return `wt-vol-${projectId}-${slug}-${suffix}`.slice(0, 100)
}

/**
 * Everything the dev server needs, as one shell command. `exec` on the last step
 * makes the dev server PID 1's direct child target for SIGTERM, so `docker stop`
 * takes a second instead of ten.
 */
function buildCommand(project: ProjectConfig): string[] {
  const steps: string[] = ['set -e']

  if (project.runtime === 'node' && project.packageManager && project.packageManager !== 'npm') {
    // corepack ships with the node images but is a no-op failure on some tags;
    // never let it take down the container.
    steps.push('corepack enable 2>/dev/null || true')
  }
  if (project.install) {
    steps.push(`echo "[wt] installing dependencies..."`)
    steps.push(project.install)
  }
  steps.push(`echo "[wt] starting: ${project.dev.replace(/"/g, '\\"')}"`)
  steps.push(`exec ${project.dev}`)

  return ['sh', '-lc', steps.join('\n')]
}

function buildEnv(project: ProjectConfig): string[] {
  const env: Record<string, string> = {
    HOST: '0.0.0.0',
    PORT: String(project.containerPort),
    FORCE_COLOR: '1',
    ...project.env,
  }

  if (project.watchPolling) {
    // Inotify events do not cross the Windows host -> Linux container boundary,
    // so hot reload silently stops working unless watchers poll instead.
    Object.assign(env, {
      CHOKIDAR_USEPOLLING: 'true',
      CHOKIDAR_INTERVAL: '300',
      WATCHPACK_POLLING: 'true',
      NEXT_WEBPACK_USEPOLLING: '1',
      VITE_SERVER_WATCH_USEPOLLING: 'true',
    })
  }

  return Object.entries(env).map(([k, v]) => `${k}=${v}`)
}

function traefikLabels(project: ProjectConfig, slug: string): Record<string, string> {
  const router = `wt-${project.id}-${slug}`
  const rule = `Host(\`${hostnameFor(slug, BASE_DOMAIN)}\`) || Host(\`${hostnameFor(slug, ALT_DOMAIN)}\`)`
  return {
    'traefik.enable': 'true',
    'traefik.docker.network': NETWORK,
    [`traefik.http.routers.${router}.rule`]: rule,
    [`traefik.http.routers.${router}.entrypoints`]: 'web',
    [`traefik.http.services.${router}.loadbalancer.server.port`]: String(project.containerPort),
  }
}

export interface UpOptions {
  project: ProjectConfig
  branch: string
  slug: string
  /** Absolute host path of the worktree. */
  hostPath: string
  /** Recreate the container even if one already exists (picks up config changes). */
  recreate?: boolean
}

export async function upWorktree(opts: UpOptions): Promise<{ containerId: string; created: boolean }> {
  const { project, branch, slug, hostPath, recreate = false } = opts
  await ensureTraefik()

  const name = containerNameFor(project.id, slug)
  let container = await findContainer(name)

  if (container && recreate) {
    await destroyContainer(container, { removeVolumes: false })
    container = null
  }

  if (container) {
    const info = await container.inspect()
    if (!info.State.Running) await container.start()
    return { containerId: info.Id, created: false }
  }

  await ensureImage(project.image)

  const binds = [`${toBindPath(hostPath)}:/workspace`]
  for (const mountPath of project.volumePaths) {
    const normalised = containerPath(mountPath)
    binds.push(`${volumeNameFor(project.id, slug, normalised)}:${normalised}`)
  }

  const created = await docker.createContainer({
    name,
    Image: project.image,
    Cmd: buildCommand(project),
    Env: buildEnv(project),
    WorkingDir: containerPath('/workspace', project.workdir),
    ExposedPorts: { [`${project.containerPort}/tcp`]: {} },
    Labels: {
      ...traefikLabels(project, slug),
      [LABEL.managed]: 'true',
      [LABEL.project]: project.id,
      [LABEL.branch]: branch,
      [LABEL.slug]: slug,
      [LABEL.hostPath]: hostPath,
      [LABEL.port]: String(project.containerPort),
    },
    HostConfig: {
      Binds: binds,
      NetworkMode: NETWORK,
      Init: true,
      // Deliberately no restart policy: a dev server that dies should stay dead
      // and visible in the dashboard rather than crash-looping quietly.
      RestartPolicy: { Name: 'no' },
    },
    NetworkingConfig: { EndpointsConfig: { [NETWORK]: {} } },
  })

  await created.start()
  return { containerId: created.id, created: true }
}

export async function stopWorktree(projectId: string, slug: string): Promise<boolean> {
  const container = await findContainer(containerNameFor(projectId, slug))
  if (!container) return false
  const info = await container.inspect()
  if (!info.State.Running) return false
  await container.stop({ t: 10 })
  return true
}

export async function restartWorktree(projectId: string, slug: string): Promise<boolean> {
  const container = await findContainer(containerNameFor(projectId, slug))
  if (!container) return false
  await container.restart({ t: 10 })
  return true
}

export async function destroyContainer(
  container: Container,
  opts: { removeVolumes?: boolean } = {},
): Promise<void> {
  try {
    await container.remove({ force: true, v: opts.removeVolumes ?? false })
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode
    if (status !== 404) throw err
  }
}

export async function removeWorktreeContainer(
  projectId: string,
  slug: string,
  removeVolumes = true,
): Promise<void> {
  const container = await findContainer(containerNameFor(projectId, slug))
  if (container) await destroyContainer(container, { removeVolumes: false })

  if (!removeVolumes) return
  const { Volumes = [] } = (await docker.listVolumes({
    filters: { name: [`wt-vol-${projectId}-${slug}-`] },
  })) as { Volumes?: Array<{ Name: string }> }

  for (const vol of Volumes) {
    if (!vol.Name.startsWith(`wt-vol-${projectId}-${slug}-`)) continue
    try {
      await docker.getVolume(vol.Name).remove({ force: true })
    } catch {
      /* volume still referenced; leave it for docker volume prune */
    }
  }
}

export async function containerLogs(
  projectId: string,
  slug: string,
  opts: { tail?: number } = {},
): Promise<string> {
  const container = await findContainer(containerNameFor(projectId, slug))
  if (!container) throw new HttpError(404, `No container for ${projectId}/${slug}`)

  const buf = (await container.logs({
    stdout: true,
    stderr: true,
    tail: opts.tail ?? 400,
    timestamps: false,
  })) as unknown as Buffer

  return demuxDockerStream(buf)
}

export async function followContainerLogs(
  projectId: string,
  slug: string,
  onChunk: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const container = await findContainer(containerNameFor(projectId, slug))
  if (!container) throw new HttpError(404, `No container for ${projectId}/${slug}`)

  const stream = (await container.logs({
    stdout: true,
    stderr: true,
    follow: true,
    tail: 200,
  })) as unknown as NodeJS.ReadableStream

  const cleanup = () => {
    const destroyable = stream as NodeJS.ReadableStream & { destroy?: () => void }
    destroyable.destroy?.()
  }
  signal.addEventListener('abort', cleanup, { once: true })

  await new Promise<void>((resolve) => {
    stream.on('data', (chunk: Buffer) => onChunk(demuxDockerStream(chunk)))
    stream.on('end', resolve)
    stream.on('error', () => resolve())
  })
  signal.removeEventListener('abort', cleanup)
}

/**
 * Non-TTY docker log streams interleave stdout and stderr behind an 8-byte
 * header per frame. Strip the headers so the dashboard shows plain text.
 */
export function demuxDockerStream(buf: Buffer): string {
  if (buf.length === 0) return ''

  // TTY streams have no framing; detect by checking the first byte is a valid
  // stream id (0-2) and the 4-byte length actually matches the buffer layout.
  const looksFramed = buf.length >= 8 && buf[0]! <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0
  if (!looksFramed) return buf.toString('utf8')

  const parts: string[] = []
  let offset = 0
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset + 4)
    const start = offset + 8
    const end = Math.min(start + length, buf.length)
    parts.push(buf.subarray(start, end).toString('utf8'))
    offset = end
    if (length === 0 && end === start) break
  }
  return parts.join('')
}

/**
 * Readiness as the browser will experience it: through Traefik, with the Host
 * header set. Catches both "container up but server not listening" and
 * "server listening on 127.0.0.1 so the proxy can't reach it".
 */
export async function probeThroughProxy(slug: string, timeoutMs = 2500): Promise<number | null> {
  // node:http rather than fetch(): `Host` is a forbidden header for fetch, which
  // drops it silently — the request then reaches Traefik with no matching route
  // and every probe reports a bogus 404.
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: HTTP_PORT,
        path: '/',
        method: 'GET',
        headers: { Host: hostnameFor(slug, BASE_DOMAIN) },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? null)
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
    req.end()
  })
}
