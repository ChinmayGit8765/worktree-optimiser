import { describe, expect, it } from 'vitest'
import { parseProcNetTcp } from '../../src/diagnose.js'

/**
 * Samples copied from real /proc/net/tcp output inside a container. The hex
 * address is little-endian for IPv4, which is exactly the detail worth pinning
 * down: getting it backwards turns 127.0.0.1 into 1.0.0.127 and the
 * bound-to-loopback diagnosis silently never fires.
 */
const IPV4 = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0
   1: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000000000000000 100 0 0 10 0
   2: 0100007F:C350 0100007F:1435 01 00000000:00000000 00:00000000 00000000     0        0 12347 1 0000000000000000 20 0 0 10 -1
`

const IPV6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22222 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:0BB9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22223 1 0000000000000000 100 0 0 10 0
`

describe('parseProcNetTcp', () => {
  it('decodes little-endian IPv4 addresses and hex ports', () => {
    const listeners = parseProcNetTcp(IPV4)
    expect(listeners).toEqual([
      { address: '0.0.0.0', port: 5173 },
      { address: '127.0.0.1', port: 3000 },
    ])
  })

  it('ignores anything not in LISTEN state', () => {
    // The third row is state 01 (ESTABLISHED); an established connection is not
    // evidence that anything is accepting new ones.
    expect(parseProcNetTcp(IPV4).some((l) => l.port === 50000)).toBe(false)
  })

  it('decodes IPv6 wildcard and loopback', () => {
    expect(parseProcNetTcp(IPV6)).toEqual([
      { address: '::', port: 8080 },
      { address: '::1', port: 3001 },
    ])
  })

  it('handles concatenated tcp and tcp6 output', () => {
    const listeners = parseProcNetTcp(`${IPV4}${IPV6}`)
    expect(listeners).toHaveLength(4)
    expect(listeners.map((l) => l.port).sort((a, b) => a - b)).toEqual([3000, 3001, 5173, 8080])
  })

  it('returns nothing for empty or header-only input', () => {
    expect(parseProcNetTcp('')).toEqual([])
    expect(parseProcNetTcp('  sl  local_address rem_address   st\n')).toEqual([])
  })

  it('distinguishes externally reachable from loopback-only on the same port', () => {
    // The whole point: a listener on 127.0.0.1:5173 inside a container is
    // unreachable from the proxy, while 0.0.0.0:5173 is fine.
    const loopbackOnly = parseProcNetTcp(
      '   0: 0100007F:1435 00000000:0000 0A 0 0 0 0 0 0 0 0 0\n',
    )
    expect(loopbackOnly).toEqual([{ address: '127.0.0.1', port: 5173 }])

    const anyAddress = parseProcNetTcp(
      '   0: 00000000:1435 00000000:0000 0A 0 0 0 0 0 0 0 0 0\n',
    )
    expect(anyAddress).toEqual([{ address: '0.0.0.0', port: 5173 }])
  })
})
