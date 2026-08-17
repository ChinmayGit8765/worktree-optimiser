import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  dockerReady,
  ensureTraefik,
  findContainer,
  probeThroughProxy,
  stopWorktree,
} from '../../src/docker.js'
import { branchExists } from '../../src/git.js'
import { ProjectConfig } from '../../src/types.js'
import { createWorktree, destroyWorktree, resolveWorktree } from '../../src/worktrees.js'

const exec = promisify(execFile)
const git = (cwd: string, args: string[]) => exec('git', args, { cwd, windowsHide: true })

/**
 * The full lifecycle against real Docker. Requires a running daemon; the whole
 * suite is skipped rather than failed when there isn't one, so `npm test` stays
 * useful on a machine without Docker.
 *
 * The fixture has no dependencies on purpose — a cold `npm install` of a real
 * framework would dominate the runtime and test npm rather than this tool.
 */
const SERVER_JS = `
const http = require('http')
const fs = require('fs')
const path = require('path')

// Re-read on every request: the point of the test is whether a host write is
// visible inside the container through the bind mount.
http
  .createServer((req, res) => {
    let marker = 'missing'
    try {
      marker = fs.readFileSync(path.join(__dirname, 'marker.txt'), 'utf8').trim()
    } catch {}
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(marker)
  })
  .listen(Number(process.env.PORT) || 3000, '0.0.0.0')
`

let tmp: string
let repoPath: string
let project: ProjectConfig
let dockerAvailable = false

async function fixtureRepo(): Promise<string> {
  const repo = path.join(tmp, 'fixture-app')
  await fs.mkdir(repo, { recursive: true })
  await fs.writeFile(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'fixture-app', private: true, scripts: { dev: 'node server.js' } }, null, 2),
  )
  await fs.writeFile(path.join(repo, 'server.js'), SERVER_JS)
  await fs.writeFile(path.join(repo, 'marker.txt'), 'v1')

  await git(repo, ['init', '-q', '-b', 'main'])
  await git(repo, ['add', '-A'])
  await git(repo, [
    '-c',
    'user.email=test@local',
    '-c',
    'user.name=test',
    'commit',
    '-q',
    '-m',
    'fixture',
  ])
  return repo
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  while (Date.now() < deadline) {
    try {
      const result = await fn()
      if (result !== null && result !== undefined && result !== false) return result as T
    } catch (err) {
      last = err
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms${last ? ` (last: ${last})` : ''}`)
}

beforeAll(async () => {
  const ready = await dockerReady()
  dockerAvailable = ready.ok
  if (!dockerAvailable) return

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-integration-'))
  repoPath = await fixtureRepo()

  project = ProjectConfig.parse({
    id: 'itest',
    name: 'itest',
    repoPath,
    worktreesRoot: path.join(tmp, 'worktrees'),
    runtime: 'node',
    image: 'node:22-bookworm-slim',
    workdir: '',
    install: null,
    dev: 'node server.js',
    containerPort: 3000,
    env: {},
    volumePaths: [],
    watchPolling: true,
    packageManager: 'npm',
  })

  await ensureTraefik()
}, 300_000)

afterAll(async () => {
  if (!dockerAvailable) return
  // Best effort: the test removes these itself on the happy path.
  await destroyWorktree(project, 'test-lifecycle', { force: true }).catch(() => {})
  if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
}, 120_000)

describe('worktree lifecycle', () => {
  it('creates, serves, reflects host edits, stops and removes cleanly', async ({ skip }) => {
    if (!dockerAvailable) skip()

    // --- create + start ----------------------------------------------------
    const created = await createWorktree(project, {
      branch: 'test/lifecycle',
      createBranch: true,
      baseRef: 'main',
      start: true,
    })
    expect(created.slug).toBe('test-lifecycle')
    expect(created.status).toBe('running')
    expect(created.hostPort).toBeGreaterThan(0)

    // --- reachable through the proxy ---------------------------------------
    const status = await waitFor(
      'the proxy to return 200',
      async () => {
        const code = await probeThroughProxy(created.slug)
        return code === 200 ? code : null
      },
      180_000,
    )
    expect(status).toBe(200)

    const read = async () => {
      const res = await fetch(`http://127.0.0.1:${created.hostPort}/`)
      return (await res.text()).trim()
    }
    expect(await read()).toBe('v1')

    // --- a host edit must be visible inside the container ------------------
    await fs.writeFile(path.join(created.path, 'marker.txt'), 'v2')
    const started = Date.now()
    const propagated = await waitFor(
      'the host edit to reach the container',
      async () => ((await read()) === 'v2' ? true : null),
      5_000,
      250,
    )
    expect(propagated).toBe(true)
    // Recorded rather than asserted tightly: this is the number the README claims.
    console.log(`    bind-mount propagation: ${Date.now() - started}ms`)

    // --- stop ---------------------------------------------------------------
    const stopReturned = await stopWorktree(project.id, created.slug)
    expect(stopReturned).toBe(true)

    const container = await findContainer(created.containerName)
    const inspected = await container!.inspect()
    console.log(
      `    after stop: docker says status=${inspected.State.Status} exit=${inspected.State.ExitCode}`,
    )
    expect(inspected.State.Running).toBe(false)

    const stopped = await resolveWorktree(project, created.slug)
    expect(stopped.status).not.toBe('running')

    // --- remove -------------------------------------------------------------
    await destroyWorktree(project, created.slug, { force: true })

    expect(await findContainer(created.containerName)).toBeNull()
    await expect(fs.access(created.path)).rejects.toThrow()
    // The branch must survive: removing a worktree is not removing work.
    expect(await branchExists(repoPath, 'test/lifecycle')).toBe(true)
  }, 400_000)

  it('refuses to remove the primary checkout', async ({ skip }) => {
    if (!dockerAvailable) skip()
    await expect(destroyWorktree(project, 'main', {})).rejects.toThrow(/primary checkout/i)
  })
})
