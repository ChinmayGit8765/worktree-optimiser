import { describe, expect, it } from 'vitest'
import { parseAccessLogRouters } from '../../src/idle.js'

/** A real line, copied from `docker logs wt-traefik`. */
const ACCESS = String.raw`172.23.0.1 - - [17/Aug/2026:13:17:17 +0000] "GET / HTTP/1.1" 200 706 "-" "-" 23 "wt-demo-app-main@docker" "http://172.23.0.3:5173" 83ms`
const ACCESS_2 = String.raw`172.23.0.1 - - [17/Aug/2026:13:18:02 +0000] "GET /src/main.js HTTP/1.1" 200 247 "-" "-" 24 "wt-demo-app-feature-new-header@docker" "http://172.23.0.4:5173" 3ms`
const WARNING = String.raw`2026-08-17T13:32:18Z WRN Failed to inspect container 22eee9cd error="No such container" providerName=docker`

describe('parseAccessLogRouters', () => {
  it('extracts the router name, which is the container name', () => {
    expect(parseAccessLogRouters(ACCESS)).toEqual(['wt-demo-app-main'])
  })

  it('handles project ids and slugs containing hyphens', () => {
    // Splitting `wt-<project>-<slug>` on hyphens would be ambiguous here; using
    // the whole router name as the container name avoids the problem entirely.
    expect(parseAccessLogRouters(ACCESS_2)).toEqual(['wt-demo-app-feature-new-header'])
  })

  it('reads every request in a batch of log output', () => {
    expect(parseAccessLogRouters([ACCESS, ACCESS_2, ACCESS].join('\n'))).toEqual([
      'wt-demo-app-main',
      'wt-demo-app-feature-new-header',
      'wt-demo-app-main',
    ])
  })

  it('ignores non-access log lines mixed into the stream', () => {
    // Traefik writes warnings to the same stream; a stray "docker" in them must
    // not register as activity.
    expect(parseAccessLogRouters(WARNING)).toEqual([])
    expect(parseAccessLogRouters([WARNING, ACCESS, WARNING].join('\n'))).toEqual([
      'wt-demo-app-main',
    ])
  })

  it('returns nothing for empty input', () => {
    expect(parseAccessLogRouters('')).toEqual([])
  })
})
