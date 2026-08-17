import { describe, expect, it } from 'vitest'
import net from 'node:net'
import { PORT_RANGE } from '../../src/config.js'
import { allocatePort, isPortFree } from '../../src/ports.js'

const [LO, HI] = PORT_RANGE

describe('allocatePort', () => {
  it('is deterministic for the same worktree identity', async () => {
    const a = await allocatePort({ key: 'demo-app/main', reserved: [] })
    const b = await allocatePort({ key: 'demo-app/main', reserved: [] })
    expect(a).toBe(b)
  })

  it('stays inside the configured range', async () => {
    for (const key of ['a/b', 'demo-app/feature-x', 'x/y-z', 'proj/really-long-branch-slug']) {
      const port = await allocatePort({ key, reserved: [] })
      expect(port).toBeGreaterThanOrEqual(LO)
      expect(port).toBeLessThanOrEqual(HI)
    }
  })

  it('gives different worktrees different ports', async () => {
    const seen = new Set<number>()
    for (let i = 0; i < 25; i++) {
      seen.add(await allocatePort({ key: `demo-app/branch-${i}`, reserved: [...seen] }))
    }
    expect(seen.size).toBe(25)
  })

  it('skips ports reserved by other containers', async () => {
    const first = await allocatePort({ key: 'demo-app/main', reserved: [] })
    const second = await allocatePort({ key: 'demo-app/main', reserved: [first] })
    expect(second).not.toBe(first)
    expect(second).toBeGreaterThanOrEqual(LO)
  })

  it('skips a port that is actually bound', async () => {
    const wanted = await allocatePort({ key: 'demo-app/occupied', reserved: [] })

    const blocker = net.createServer()
    await new Promise<void>((resolve) =>
      blocker.listen({ port: wanted, host: '127.0.0.1', exclusive: true }, resolve),
    )
    try {
      expect(await isPortFree(wanted)).toBe(false)
      const next = await allocatePort({ key: 'demo-app/occupied', reserved: [] })
      expect(next).not.toBe(wanted)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
})
