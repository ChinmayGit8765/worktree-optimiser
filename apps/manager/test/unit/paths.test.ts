import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  assertInsideReal,
  containerPath,
  isInside,
  isSuspiciousRelative,
  toBindPath,
} from '../../src/paths.js'

describe('toBindPath', () => {
  it('converts a Windows path for Docker Desktop', () => {
    expect(toBindPath('C:\\dev\\app', 'win')).toBe('C:/dev/app')
    expect(toBindPath('c:\\dev\\app', 'win')).toBe('C:/dev/app')
    expect(toBindPath('C:\\dev\\app\\nested dir', 'win')).toBe('C:/dev/app/nested dir')
  })

  it('converts a Windows path for a WSL-hosted daemon', () => {
    expect(toBindPath('C:\\dev\\app', 'wsl')).toBe('/mnt/c/dev/app')
    expect(toBindPath('D:\\x\\y', 'wsl')).toBe('/mnt/d/x/y')
  })

  it('passes POSIX paths through untouched', () => {
    // Asserted literally, not against path.resolve: the result must not depend on
    // which platform the test runs on.
    expect(toBindPath('/home/me/app', 'unix')).toBe('/home/me/app')
    expect(toBindPath('/home/me/app', 'win')).toBe('/home/me/app')
    expect(toBindPath('/home/me//app/', 'unix')).toBe('/home/me/app/')
  })

  it('classifies by the input path style, not the host platform', () => {
    // Regression: resolving first meant a Windows-style path on Linux became
    // "/cwd/C:/dev/app", which Docker would happily bind as a literal directory.
    for (const style of ['win', 'wsl', 'unix'] as const) {
      expect(toBindPath('C:\\dev\\app', style)).not.toContain(process.cwd())
    }
  })

  it('leaves UNC paths recognisable', () => {
    expect(toBindPath('\\\\server\\share\\app', 'win')).toBe('//server/share/app')
  })
})

describe('containerPath', () => {
  it('always produces POSIX paths regardless of host separators', () => {
    expect(containerPath('/workspace', 'apps\\web', 'node_modules')).toBe(
      '/workspace/apps/web/node_modules',
    )
  })

  it('collapses duplicate separators and ignores empty segments', () => {
    expect(containerPath('/workspace', '', 'node_modules')).toBe('/workspace/node_modules')
    expect(containerPath('/workspace/', '/sub')).toBe('/workspace/sub')
  })
})

describe('isInside — lexical containment', () => {
  const root = path.resolve('/srv/worktrees')

  it('accepts the root itself and genuine descendants', () => {
    expect(isInside(root, root)).toBe(true)
    expect(isInside(root, path.join(root, 'feature'))).toBe(true)
    expect(isInside(root, path.join(root, 'a', 'b', 'c.txt'))).toBe(true)
  })

  it('rejects parent traversal', () => {
    expect(isInside(root, path.join(root, '..'))).toBe(false)
    expect(isInside(root, path.join(root, '..', '..', 'etc'))).toBe(false)
    expect(isInside(root, path.resolve('/srv'))).toBe(false)
  })

  it('rejects a sibling whose name merely shares the prefix', () => {
    // The classic off-by-one: /srv/worktrees-evil must not count as inside
    // /srv/worktrees just because the string starts the same way.
    expect(isInside(root, path.resolve('/srv/worktrees-evil'))).toBe(false)
    expect(isInside(root, path.resolve('/srv/worktreesevil'))).toBe(false)
  })

  it('accepts a legitimate entry whose name begins with dots', () => {
    // Regression: a bare rel.startsWith('..') test rejected these.
    expect(isInside(root, path.join(root, '..hidden'))).toBe(true)
    expect(isInside(root, path.join(root, '...weird'))).toBe(true)
  })

  it('rejects an unrelated absolute path', () => {
    expect(isInside(root, path.resolve('/etc/passwd'))).toBe(false)
  })
})

describe('isSuspiciousRelative — inputs that only look relative', () => {
  it('rejects Windows drive-relative paths', () => {
    // `C:foo` resolves against the *current directory of drive C:*, not against
    // whatever it is joined to, so it escapes naive containment.
    expect(isSuspiciousRelative('C:foo')).toBe(true)
    expect(isSuspiciousRelative('C:\\Windows\\System32')).toBe(true)
    expect(isSuspiciousRelative('d:x')).toBe(true)
  })

  it('rejects UNC paths', () => {
    expect(isSuspiciousRelative('\\\\server\\share\\secret')).toBe(true)
    expect(isSuspiciousRelative('//server/share')).toBe(true)
  })

  it('rejects rooted paths', () => {
    expect(isSuspiciousRelative('/etc/passwd')).toBe(true)
    expect(isSuspiciousRelative('\\Windows')).toBe(true)
  })

  it('rejects NUL truncation attempts', () => {
    expect(isSuspiciousRelative('ok.txt\0.png')).toBe(true)
  })

  it('accepts ordinary relative paths', () => {
    expect(isSuspiciousRelative('')).toBe(false)
    expect(isSuspiciousRelative('src/main.ts')).toBe(false)
    expect(isSuspiciousRelative('src\\main.ts')).toBe(false)
    expect(isSuspiciousRelative('..hidden')).toBe(false)
  })
})

describe('assertInsideReal — symlink escapes', () => {
  let tmp: string
  let root: string
  let outside: string
  let dirLinkKind: 'junction' | 'dir' | null = null
  let fileLinkOk = false

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-paths-'))
    root = path.join(tmp, 'worktrees')
    outside = path.join(tmp, 'secrets')
    await fs.mkdir(root, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(path.join(outside, 'creds.txt'), 'sensitive', 'utf8')
    await fs.writeFile(path.join(root, 'ok.txt'), 'fine', 'utf8')

    // Windows grants junction creation to unelevated users but not symlinks, so
    // probe which kinds are actually available instead of assuming.
    for (const kind of ['junction', 'dir'] as const) {
      try {
        const probe = path.join(root, `probe-${kind}`)
        await fs.symlink(outside, probe, kind)
        await fs.rm(probe, { recursive: true, force: true })
        dirLinkKind = kind
        break
      } catch {
        /* try the next kind */
      }
    }
    try {
      const probe = path.join(root, 'probe-file')
      await fs.symlink(path.join(outside, 'creds.txt'), probe, 'file')
      await fs.rm(probe, { force: true })
      fileLinkOk = true
    } catch {
      fileLinkOk = false
    }
  })

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('accepts a real file inside the root', async () => {
    await expect(assertInsideReal(root, path.join(root, 'ok.txt'))).resolves.toBeTruthy()
  })

  it('rejects a directory link inside the root that points outside it', async ({ skip }) => {
    if (!dirLinkKind) skip()
    const link = path.join(root, 'escape')
    await fs.symlink(outside, link, dirLinkKind!)
    const target = path.join(link, 'creds.txt')

    // Prove the test is not vacuous: without a guard this genuinely reads the
    // file outside the root.
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('sensitive')
    // And the lexical check alone is fooled — the path really is under root.
    expect(isInside(root, target)).toBe(true)

    await expect(assertInsideReal(root, target)).rejects.toThrow(/escapes/i)
  })

  it('rejects a file symlink that resolves outside the root', async ({ skip }) => {
    if (!fileLinkOk) skip()
    const link = path.join(root, 'creds-link.txt')
    await fs.symlink(path.join(outside, 'creds.txt'), link, 'file')

    await expect(fs.readFile(link, 'utf8')).resolves.toBe('sensitive')
    await expect(assertInsideReal(root, link)).rejects.toThrow(/escapes/i)
  })

  it('rejects a nested path reached through a directory link', async ({ skip }) => {
    if (!dirLinkKind) skip()
    await fs.mkdir(path.join(outside, 'deep', 'deeper'), { recursive: true })
    await fs.writeFile(path.join(outside, 'deep', 'deeper', 'x.txt'), 'nested', 'utf8')

    const link = path.join(root, 'escape2')
    await fs.symlink(outside, link, dirLinkKind!)
    const target = path.join(link, 'deep', 'deeper', 'x.txt')

    await expect(fs.readFile(target, 'utf8')).resolves.toBe('nested')
    await expect(assertInsideReal(root, target)).rejects.toThrow(/escapes/i)
  })

  it('allows a path that does not exist yet but whose parent is inside', async () => {
    await expect(assertInsideReal(root, path.join(root, 'not-created-yet'))).resolves.toBeTruthy()
  })

  it('allows a deep path whose intermediate directories do not exist yet', async () => {
    // Regression: resolving only one level up threw ENOENT here instead of
    // deciding containment.
    const target = path.join(root, 'a', 'b', 'c', 'file.txt')
    await expect(assertInsideReal(root, target)).resolves.toBeTruthy()
  })

  it('rejects a not-yet-existing path under a directory link', async ({ skip }) => {
    if (!dirLinkKind) skip()
    const link = path.join(root, 'escape3')
    await fs.symlink(outside, link, dirLinkKind!)
    await expect(assertInsideReal(root, path.join(link, 'new-file.txt'))).rejects.toThrow(
      /escapes/i,
    )
  })
})
