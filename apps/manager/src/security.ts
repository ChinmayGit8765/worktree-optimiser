import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ALLOWED_HOSTS, AUTH_TOKEN, BIND_HOST, MANAGER_PORT, isLoopbackHost } from './config.js'

/**
 * This process can delete directories on the host, read any file in a registered
 * repo, and start containers. Three separate things have to be true for that to
 * be safe, and only the first is obvious:
 *
 *  1. It must not listen on a routable interface (see index.ts — loopback default).
 *  2. A web page you visit must not be able to call it. Browsers happily let
 *     any origin fetch http://localhost:7777; only CORS stops the response being
 *     readable, so the allowlist has to be strict rather than reflective.
 *  3. A hostname resolving to 127.0.0.1 must not be usable to bypass (2) — the
 *     DNS-rebinding case, which CORS does not address. Hence the Host allowlist.
 */

/** Origins permitted to read API responses. Reflective CORS is not acceptable here. */
export function allowedOrigins(): string[] {
  const explicit = process.env.WT_ALLOWED_ORIGINS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (explicit?.length) return explicit

  const origins = [
    `http://localhost:${MANAGER_PORT}`,
    `http://127.0.0.1:${MANAGER_PORT}`,
    // Vite dev server for the dashboard
    'http://localhost:7788',
    'http://127.0.0.1:7788',
  ]
  if (!isLoopbackHost(BIND_HOST)) {
    origins.push(`http://${BIND_HOST}:${MANAGER_PORT}`)
  }
  return origins
}

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null
  // Strip the port. Bracketed IPv6 literals keep their brackets.
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader.trim())
  return m ? m[1]!.toLowerCase() : null
}

export function registerSecurity(app: FastifyInstance): void {
  const hosts = new Set(ALLOWED_HOSTS.map((h) => h.toLowerCase()))

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // --- DNS-rebinding guard -------------------------------------------------
    // An attacker-controlled name that resolves to 127.0.0.1 reaches us with its
    // own Host header. Rejecting unknown Host values closes that path; CORS alone
    // does not, because the attacker's page is then same-origin with us.
    const host = hostnameOf(req.headers.host)
    if (host && !hosts.has(host)) {
      return reply.status(403).send({
        error: `Host "${host}" is not allowed. Reach the manager on localhost, or set WT_ALLOWED_HOSTS.`,
      })
    }

    if (!req.url.startsWith('/api/')) return

    // --- Token ---------------------------------------------------------------
    if (!AUTH_TOKEN) return

    const header = req.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null
    const query = (req.query as { token?: string } | undefined)?.token
    const supplied = bearer ?? query ?? null

    if (!supplied || !timingSafeEqual(supplied, AUTH_TOKEN)) {
      return reply
        .status(401)
        .send({ error: 'Missing or invalid token. Send Authorization: Bearer <WT_TOKEN>.' })
    }
  })
}

/** Constant-time compare so the token can't be recovered by timing the response. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
