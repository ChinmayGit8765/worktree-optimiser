import path from 'node:path'
import fs from 'node:fs'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { MANAGER_PORT, REPO_ROOT } from './config.js'
import { dockerReady, ensureTraefik } from './docker.js'
import { registerRoutes } from './routes.js'

const app = Fastify({
  logger: {
    level: process.env.WT_LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  },
})

await app.register(cors, { origin: true })
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

await app.listen({ port: MANAGER_PORT, host: '0.0.0.0' })
app.log.info(`Manager dashboard: http://localhost:${MANAGER_PORT}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`)
    // Worktree containers deliberately keep running: the manager is a control
    // plane, not a supervisor. Restarting it must not kill anyone's dev server.
    void app.close().then(() => process.exit(0))
  })
}
