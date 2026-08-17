import path from 'node:path'
import fs from 'node:fs'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import {
  AUTH_TOKEN,
  BIND_HOST,
  MANAGER_PORT,
  PROXY_BIND_HOST,
  REPO_ROOT,
  isLoopbackHost,
} from './config.js'
import { dockerReady, ensureTraefik } from './docker.js'
import { IdleReaper } from './idle.js'
import { registerRoutes } from './routes.js'
import { allowedOrigins, registerSecurity } from './security.js'

// Refuse to expose destructive, unauthenticated endpoints to a network. This is a
// hard failure rather than a warning: a warning in a scrollback buffer is not a
// security control.
if (!isLoopbackHost(BIND_HOST) && !AUTH_TOKEN) {
  console.error(
    `\nRefusing to start.\n\n` +
      `  WT_HOST is set to "${BIND_HOST}", which is not loopback, but WT_TOKEN is unset.\n` +
      `  The manager can delete directories on this host and read files from any\n` +
      `  registered repository, so it must not be reachable from a network without\n` +
      `  authentication.\n\n` +
      `  Either unset WT_HOST (binds 127.0.0.1), or set WT_TOKEN to a secret value.\n`,
  )
  process.exit(1)
}

const app = Fastify({
  logger: {
    level: process.env.WT_LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  },
})

// A strict allowlist, not `origin: true`. Reflective CORS would let any web page
// you happen to visit read this API's responses over localhost.
await app.register(cors, { origin: allowedOrigins(), credentials: false })
registerSecurity(app)
await registerRoutes(app)

// The built dashboard, when it exists. In dev the Vite server proxies to us instead.
const publicDir = path.join(REPO_ROOT, 'apps', 'manager', 'public')
if (fs.existsSync(path.join(publicDir, 'index.html'))) {
  await app.register(fastifyStatic, { root: publicDir })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: `No route for ${req.method} ${req.url}` })
    }
    return reply.sendFile('index.html')
  })
} else {
  app.log.warn('Dashboard bundle not found — run `npm run build` or use `npm run dev:web`.')
}

const ready = await dockerReady()
if (ready.ok) {
  try {
    await ensureTraefik()
    app.log.info('Traefik proxy is up')
  } catch (err) {
    app.log.error({ err }, 'Could not start the Traefik proxy')
  }
} else {
  app.log.warn(`Docker is not reachable: ${ready.error}`)
}

const idleReaper = new IdleReaper(app.log)
if (ready.ok) idleReaper.start()

await app.listen({ port: MANAGER_PORT, host: BIND_HOST })
app.log.info(`Manager dashboard: http://localhost:${MANAGER_PORT}`)
app.log.info(
  `Bound to ${BIND_HOST}; proxy publishes worktrees on ${PROXY_BIND_HOST}` +
    (AUTH_TOKEN ? ' (token required)' : ''),
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`)
    idleReaper.stop()
    // Worktree containers deliberately keep running: the manager is a control
    // plane, not a supervisor. Restarting it must not kill anyone's dev server.
    void app.close().then(() => process.exit(0))
  })
}
