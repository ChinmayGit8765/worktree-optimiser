import type { FastifyBaseLogger } from 'fastify'
import { IDLE_STOP_MINUTES, LABEL } from './config.js'
import { demuxDockerStream, docker, findContainer, listManagedContainers } from './docker.js'

/**
 * Stops worktree containers that nobody has visited for a while.
 *
 * Off by default. It only ever *stops* — the worktree, its branch and its
 * dependency volumes are untouched, so restarting is quick and nothing can be
 * lost by leaving it on.
 *
 * Activity comes from Traefik's access log, which records the router name for
 * every request: `"wt-demo-app-main@docker"`. That name is exactly the container
 * name, so it maps back without guessing (a project id containing hyphens would
 * otherwise make `wt-<project>-<slug>` ambiguous to split).
 *
 * Last-seen times live in memory. After a manager restart nothing has a recorded
 * visit, so containers are measured from their start time instead — a restart
 * cannot cause a surprise mass shutdown.
 */

const ROUTER_IN_ACCESS_LOG = /"(wt-[^"@\s]+)@docker"/g

/**
 * Container names that served a request, from Traefik's CLF access log. The
 * router field is quoted and suffixed with the provider, e.g.
 * `"wt-demo-app-main@docker"`, and the router name is the container name.
 */
export function parseAccessLogRouters(text: string): string[] {
  return [...text.matchAll(ROUTER_IN_ACCESS_LOG)].map((m) => m[1]!)
}

export class IdleReaper {
  private readonly lastSeen = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private logCursor = Math.floor(Date.now() / 1000)

  constructor(private readonly log: FastifyBaseLogger) {}

  get enabled(): boolean {
    return IDLE_STOP_MINUTES > 0
  }

  start(): void {
    if (!this.enabled || this.timer) return

    // Check often enough to be roughly accurate, but never more than once a
    // minute: this reads a log and lists containers on every tick.
    const intervalMs = Math.min(60_000, Math.max(15_000, (IDLE_STOP_MINUTES * 60_000) / 4))
    this.timer = setInterval(() => void this.tick(), intervalMs)
    this.timer.unref?.()

    this.log.info(
      `Idle stop enabled: worktrees with no requests for ${IDLE_STOP_MINUTES} minute(s) will be stopped.`,
    )
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Exposed for tests and for the dashboard to show why something was stopped. */
  lastSeenAt(containerName: string): number | null {
    return this.lastSeen.get(containerName) ?? null
  }

  private async tick(): Promise<void> {
    try {
      await this.ingestAccessLog()
      await this.reap()
    } catch (err) {
      this.log.warn({ err }, 'Idle check failed')
    }
  }

  /** Read whatever Traefik has logged since the last pass and record activity. */
  private async ingestAccessLog(): Promise<void> {
    const proxy = await findContainer('wt-traefik')
    if (!proxy) return

    const since = this.logCursor
    this.logCursor = Math.floor(Date.now() / 1000)

    const buf = (await proxy.logs({
      stdout: true,
      stderr: false,
      since,
      timestamps: false,
    })) as unknown as Buffer

    const text = demuxDockerStream(buf)
    const now = Date.now()
    for (const match of text.matchAll(ROUTER_IN_ACCESS_LOG)) {
      this.lastSeen.set(match[1]!, now)
    }
  }

  private async reap(): Promise<void> {
    const threshold = IDLE_STOP_MINUTES * 60_000
    const now = Date.now()

    for (const info of await listManagedContainers()) {
      if (info.State !== 'running') continue

      const name = info.Names.find((n) => n.startsWith('/'))?.slice(1)
      if (!name) continue

      // First sighting since this process started: begin the clock now rather
      // than judging it on a start time we have no activity data for. A
      // container started hours ago may have been in use seconds ago, and
      // falling back to its creation time reaps it the moment the manager
      // restarts — which is exactly the surprise this is meant to avoid.
      const reference = this.lastSeen.get(name)
      if (reference === undefined) {
        this.lastSeen.set(name, now)
        continue
      }
      if (now - reference < threshold) continue

      const branch = info.Labels?.[LABEL.branch] ?? name
      try {
        await docker.getContainer(info.Id).stop({ t: 10 })
        this.lastSeen.delete(name)
        this.log.info(
          `Stopped ${branch}: no requests for ${Math.round((now - reference) / 60_000)} minute(s). ` +
            'Nothing was deleted; starting it again is quick.',
        )
      } catch (err) {
        this.log.warn({ err }, `Could not stop idle container ${name}`)
      }
    }
  }
}
