import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDotEnv } from '../../src/env.js'

/**
 * The launcher and the .env loader both run before anything else does, and both
 * fail in ways nothing else would catch: a help flag that silently boots a server,
 * or a .env that is read by nobody.
 */

const exec = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..', '..')
const BIN = path.join(repoRoot, 'bin', 'worktree-optimiser.js')

const run = (args: string[]) =>
  exec(process.execPath, [BIN, ...args], { cwd: repoRoot, windowsHide: true })

describe('bin/worktree-optimiser', () => {
  it('prints help for every help form instead of starting the server', async () => {
    for (const flag of ['help', '--help', '-h']) {
      const { stdout } = await run([flag])
      expect(stdout, `\`${flag}\` should print usage`).toContain('run the MCP server on stdio')
    }
  })

  it('rejects an unknown subcommand with a non-zero exit', async () => {
    await expect(run(['nonsense'])).rejects.toMatchObject({ code: 1 })
  })

  it('does not resolve inherited Object properties as subcommands', async () => {
    // Without a null-prototype lookup table this hands `path.join` a function.
    await expect(run(['constructor'])).rejects.toMatchObject({ code: 1 })
  })
})

describe('loadDotEnv', () => {
  // A name no real .env would carry, so nothing here depends on the machine it
  // runs on.
  const KEY = 'WT_DOTENV_PROBE'
  const dirs: string[] = []

  afterEach(async () => {
    delete process.env[KEY]
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  })

  async function dirWith(contents?: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-env-'))
    dirs.push(dir)
    if (contents !== undefined) await fs.writeFile(path.join(dir, '.env'), contents)
    return dir
  }

  it('reads the first .env it finds', async () => {
    const dir = await dirWith(`${KEY}=9123\n`)
    expect(loadDotEnv([dir])).toBe(path.join(dir, '.env'))
    expect(process.env[KEY]).toBe('9123')
  })

  it('leaves an already-exported variable alone', async () => {
    // Same precedence as --env-file: the environment beats the file, so
    // `WT_HTTP_PORT=8080 npm start` still works with a .env present.
    process.env[KEY] = '7000'
    const dir = await dirWith(`${KEY}=9123\n`)
    loadDotEnv([dir])
    expect(process.env[KEY]).toBe('7000')
  })

  it('stops at the first directory that has one', async () => {
    const [first, second] = [await dirWith(`${KEY}=first\n`), await dirWith(`${KEY}=second\n`)]
    expect(loadDotEnv([first, second])).toBe(path.join(first, '.env'))
    expect(process.env[KEY]).toBe('first')
  })

  it('falls through a directory without a .env', async () => {
    const [empty, withFile] = [await dirWith(), await dirWith(`${KEY}=fallback\n`)]
    expect(loadDotEnv([empty, withFile])).toBe(path.join(withFile, '.env'))
    expect(process.env[KEY]).toBe('fallback')
  })

  it('is a no-op when nothing has one', async () => {
    expect(loadDotEnv([await dirWith()])).toBeNull()
    expect(process.env[KEY]).toBeUndefined()
  })
})
