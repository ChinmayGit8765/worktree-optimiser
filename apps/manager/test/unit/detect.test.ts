import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { detectProject } from '../../src/detect.js'

let tmp: string

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-detect-'))
})
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

/** Build a throwaway repo on disk; detection reads real files, so fixtures are real. */
async function fixture(
  name: string,
  files: Record<string, string | object>,
): Promise<string> {
  const dir = path.join(tmp, name)
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(
      target,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      'utf8',
    )
  }
  return dir
}

const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  name: 'fixture',
  private: true,
  scripts: { dev: 'dev-script' },
  dependencies: deps,
  ...extra,
})

describe('framework detection', () => {
  const cases: Array<{
    name: string
    deps: Record<string, string>
    files?: Record<string, string | object>
    framework: string
    port: number
    /** Substring the generated dev command must contain to bind externally. */
    hostFlag: string
  }> = [
    { name: 'next', deps: { next: '15.0.0' }, framework: 'next', port: 3000, hostFlag: '-H 0.0.0.0' },
    { name: 'nuxt', deps: { nuxt: '3.0.0' }, framework: 'nuxt', port: 3000, hostFlag: '--host 0.0.0.0' },
    {
      name: 'sveltekit',
      deps: { '@sveltejs/kit': '2.0.0' },
      framework: 'sveltekit',
      port: 5173,
      hostFlag: '--host 0.0.0.0',
    },
    { name: 'astro', deps: { astro: '4.0.0' }, framework: 'astro', port: 4321, hostFlag: '--host 0.0.0.0' },
    {
      name: 'remix',
      deps: { '@remix-run/dev': '2.0.0' },
      framework: 'remix',
      port: 3000,
      hostFlag: '--host 0.0.0.0',
    },
    { name: 'gatsby', deps: { gatsby: '5.0.0' }, framework: 'gatsby', port: 8000, hostFlag: '-H 0.0.0.0' },
    {
      name: 'angular',
      deps: { '@angular/core': '18.0.0' },
      framework: 'angular',
      port: 4200,
      hostFlag: '--host 0.0.0.0',
    },
    { name: 'vite', deps: { vite: '6.0.0' }, framework: 'vite', port: 5173, hostFlag: '--host 0.0.0.0' },
    { name: 'nestjs', deps: { '@nestjs/core': '10.0.0' }, framework: 'nestjs', port: 3000, hostFlag: '' },
    { name: 'express', deps: { express: '4.0.0' }, framework: 'node-server', port: 3000, hostFlag: '' },
  ]

  for (const c of cases) {
    it(`detects ${c.name}`, async () => {
      const dir = await fixture(`fx-${c.name}`, { 'package.json': pkg(c.deps), ...(c.files ?? {}) })
      const detection = await detectProject(dir)
      const best = detection.candidates[0]!

      expect(detection.runtime).toBe('node')
      expect(best.framework).toBe(c.framework)
      expect(best.containerPort).toBe(c.port)
      if (c.hostFlag) expect(best.dev).toContain(c.hostFlag)
      // Everything must bind externally one way or another, or the proxy 502s.
      expect(best.dev.includes('0.0.0.0') || best.env.HOST === '0.0.0.0').toBe(true)
    })
  }

  it('detects create-react-app, which has no host flag', async () => {
    const dir = await fixture('fx-cra', { 'package.json': pkg({ 'react-scripts': '5.0.0' }) })
    const best = (await detectProject(dir)).candidates[0]!
    expect(best.framework).toBe('create-react-app')
    // CRA takes HOST from the environment; there is no CLI flag for it.
    expect(best.env.HOST).toBe('0.0.0.0')
  })

  it('detects vite from a config file even without the dependency', async () => {
    const dir = await fixture('fx-vite-config', {
      'package.json': pkg({}),
      'vite.config.ts': 'export default {}',
    })
    expect((await detectProject(dir)).candidates[0]!.framework).toBe('vite')
  })
})

describe('package manager detection', () => {
  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ])('uses %s -> %s', async (lockfile, expected) => {
    const dir = await fixture(`fx-pm-${expected}`, {
      'package.json': pkg({ vite: '6.0.0' }),
      [lockfile]: '',
    })
    const best = (await detectProject(dir)).candidates[0]!
    expect(best.packageManager).toBe(expected)
    expect(best.install).toContain(expected)
  })

  it('prefers an explicit packageManager field over a lockfile', async () => {
    const dir = await fixture('fx-pm-explicit', {
      'package.json': pkg({ vite: '6.0.0' }, { packageManager: 'pnpm@9.0.0' }),
      'package-lock.json': '',
    })
    expect((await detectProject(dir)).candidates[0]!.packageManager).toBe('pnpm')
  })
})

describe('node image selection', () => {
  it('honours .nvmrc', async () => {
    const dir = await fixture('fx-nvmrc', { 'package.json': pkg({}), '.nvmrc': 'v20.11.0' })
    expect((await detectProject(dir)).image).toBe('node:20-bookworm-slim')
  })

  it('honours engines.node', async () => {
    const dir = await fixture('fx-engines', {
      'package.json': pkg({}, { engines: { node: '>=18' } }),
    })
    expect((await detectProject(dir)).image).toBe('node:18-bookworm-slim')
  })

  it('clamps versions without corepack to a supported default', async () => {
    const dir = await fixture('fx-old-node', { 'package.json': pkg({}), '.nvmrc': '14' })
    expect((await detectProject(dir)).image).toBe('node:22-bookworm-slim')
  })
})

describe('monorepo handling', () => {
  it('finds workspace apps and de-prioritises the root', async () => {
    const dir = await fixture('fx-mono', {
      'package.json': {
        name: 'root',
        private: true,
        workspaces: ['apps/*'],
        scripts: { dev: 'turbo dev' },
      },
      'apps/web/package.json': pkg({ next: '15.0.0' }),
      'apps/api/package.json': pkg({ fastify: '5.0.0' }),
      'pnpm-lock.yaml': '',
    })
    const detection = await detectProject(dir)

    expect(detection.isMonorepo).toBe(true)
    expect(detection.notes.join(' ')).toMatch(/monorepo/i)

    const workdirs = detection.candidates.map((c) => c.workdir)
    expect(workdirs).toContain('apps/web')
    expect(workdirs).toContain('apps/api')

    // A root `dev` that fans out via turbo has no single port to route, so it
    // must not be the default suggestion.
    expect(detection.candidates[0]!.workdir).not.toBe('')
  })

  it('mounts both root and package node_modules for a workspace app', async () => {
    const dir = await fixture('fx-mono-vols', {
      'package.json': { name: 'root', private: true, workspaces: ['apps/*'] },
      'apps/web/package.json': pkg({ vite: '6.0.0' }),
    })
    const web = (await detectProject(dir)).candidates.find((c) => c.workdir === 'apps/web')!
    expect(web.volumePaths).toContain('/workspace/node_modules')
    expect(web.volumePaths).toContain('/workspace/apps/web/node_modules')
  })
})

describe('non-node projects', () => {
  it('detects Django', async () => {
    const dir = await fixture('fx-django', {
      'manage.py': '# django',
      'requirements.txt': 'django==5.0',
    })
    const detection = await detectProject(dir)
    expect(detection.runtime).toBe('python')
    expect(detection.candidates[0]!.dev).toContain('0.0.0.0:8000')
  })

  it('detects FastAPI', async () => {
    const dir = await fixture('fx-fastapi', { 'requirements.txt': 'fastapi\nuvicorn' })
    const best = (await detectProject(dir)).candidates[0]!
    expect(best.framework).toBe('fastapi')
    expect(best.dev).toContain('--host 0.0.0.0')
  })

  it('falls back to static nginx with a note when nothing is recognised', async () => {
    const dir = await fixture('fx-static', { 'index.html': '<h1>hi</h1>' })
    const detection = await detectProject(dir)
    expect(detection.runtime).toBe('static')
    expect(detection.notes.length).toBeGreaterThan(0)
  })

  it('reports no candidates when package.json has no dev script', async () => {
    const dir = await fixture('fx-nodev', {
      'package.json': { name: 'lib', private: true, scripts: { build: 'tsc' } },
    })
    const detection = await detectProject(dir)
    expect(detection.candidates).toHaveLength(0)
    expect(detection.notes.join(' ')).toMatch(/dev/i)
  })
})
