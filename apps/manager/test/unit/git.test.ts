import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  addWorktree,
  branchExists,
  defaultBranch,
  diffSummary,
  filePatch,
  listBranches,
  listWorktrees,
  removeWorktree,
  workingState,
} from '../../src/git.js'

const exec = promisify(execFile)

/**
 * Exercised against a real repository rather than fixture strings: the point of
 * these functions is parsing what git actually emits, and a hand-written sample
 * only proves the parser agrees with my memory of the format.
 */
let tmp: string
let repo: string
const git = (args: string[], cwd = repo) =>
  exec('git', ['-c', 'user.email=t@local', '-c', 'user.name=t', ...args], { cwd, windowsHide: true })

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-git-'))
  repo = path.join(tmp, 'repo')
  await fs.mkdir(repo, { recursive: true })

  await git(['init', '-q', '-b', 'main'])
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\n')
  await fs.writeFile(path.join(repo, 'keep.txt'), 'keep\n')
  await git(['add', '-A'])
  await git(['commit', '-q', '-m', 'initial'])

  // A branch with one commit ahead of main.
  await git(['checkout', '-q', '-b', 'feature/thing'])
  await fs.writeFile(path.join(repo, 'a.txt'), 'two\n')
  await fs.writeFile(path.join(repo, 'added.txt'), 'new file\n')
  await git(['add', '-A'])
  await git(['commit', '-q', '-m', 'feature commit'])
  await git(['checkout', '-q', 'main'])
}, 60_000)

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
})

describe('listWorktrees — porcelain parsing', () => {
  it('reads the primary checkout', async () => {
    const trees = await listWorktrees(repo)
    expect(trees).toHaveLength(1)
    expect(trees[0]!.branch).toBe('main')
    expect(trees[0]!.bare).toBe(false)
    expect(trees[0]!.detached).toBe(false)
    expect(path.resolve(trees[0]!.path)).toBe(path.resolve(repo))
    expect(trees[0]!.head).toMatch(/^[0-9a-f]{40}$/)
  })

  it('reads an added worktree and drops the refs/heads/ prefix', async () => {
    const wtPath = path.join(tmp, 'wt-feature')
    await addWorktree(repo, 'feature/thing', wtPath)
    try {
      const trees = await listWorktrees(repo)
      expect(trees).toHaveLength(2)
      const added = trees.find((t) => t.branch === 'feature/thing')
      expect(added).toBeDefined()
      expect(added!.branch).not.toContain('refs/heads/')
      expect(path.resolve(added!.path)).toBe(path.resolve(wtPath))
    } finally {
      await removeWorktree(repo, wtPath, true)
    }
  })

  it('refuses to check the same branch out twice', async () => {
    const first = path.join(tmp, 'wt-dup-1')
    const second = path.join(tmp, 'wt-dup-2')
    await addWorktree(repo, 'feature/thing', first)
    try {
      await expect(addWorktree(repo, 'feature/thing', second)).rejects.toThrow(
        /already checked out/i,
      )
    } finally {
      await removeWorktree(repo, first, true)
    }
  })

  it('creates a branch on demand from a base ref', async () => {
    const wtPath = path.join(tmp, 'wt-new')
    await addWorktree(repo, 'brand/new', wtPath, { createBranch: true, baseRef: 'main' })
    try {
      expect(await branchExists(repo, 'brand/new')).toBe(true)
    } finally {
      await removeWorktree(repo, wtPath, true)
    }
    // Removing the worktree must not remove the branch.
    expect(await branchExists(repo, 'brand/new')).toBe(true)
  })

  it('rejects an unknown branch unless createBranch is set', async () => {
    await expect(addWorktree(repo, 'does/not/exist', path.join(tmp, 'wt-nope'))).rejects.toThrow(
      /does not exist/i,
    )
  })
})

describe('listBranches', () => {
  it('lists local branches with tips and marks which are checked out', async () => {
    const branches = await listBranches(repo)
    const names = branches.map((b) => b.name)
    expect(names).toContain('main')
    expect(names).toContain('feature/thing')

    const main = branches.find((b) => b.name === 'main')!
    expect(main.kind).toBe('local')
    expect(main.head).toMatch(/^[0-9a-f]{7,}$/)
    expect(main.checkedOutAt).not.toBeNull()

    expect(branches.find((b) => b.name === 'feature/thing')!.checkedOutAt).toBeNull()
  })
})

describe('defaultBranch', () => {
  it('falls back to a conventional name when origin/HEAD is absent', async () => {
    expect(await defaultBranch(repo)).toBe('main')
  })
})

describe('workingState — porcelain v2 parsing', () => {
  it('reports a clean tree', async () => {
    const state = await workingState(repo)
    expect(state.dirty).toBe(false)
    expect(state.changedFiles).toBe(0)
    expect(state.head).toMatch(/^[0-9a-f]{8}$/)
  })

  it('counts modified and untracked files', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'modified\n')
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'x\n')
    try {
      const state = await workingState(repo)
      expect(state.dirty).toBe(true)
      expect(state.changedFiles).toBeGreaterThanOrEqual(2)
    } finally {
      await git(['checkout', '--', 'a.txt'])
      await fs.rm(path.join(repo, 'untracked.txt'), { force: true })
    }
  })
})

describe('diffSummary', () => {
  it('reports commits ahead and the files they changed', async () => {
    const wtPath = path.join(tmp, 'wt-diff')
    await addWorktree(repo, 'feature/thing', wtPath)
    try {
      const diff = await diffSummary(wtPath, 'main')
      expect(diff.base).toBe('main')
      expect(diff.ahead).toBe(1)
      expect(diff.behind).toBe(0)

      const paths = diff.committed.map((f) => f.path).sort()
      expect(paths).toEqual(['a.txt', 'added.txt'])

      const modified = diff.committed.find((f) => f.path === 'a.txt')!
      expect(modified.status).toBe('M')
      expect(modified.additions).toBe(1)
      expect(modified.deletions).toBe(1)

      expect(diff.committed.find((f) => f.path === 'added.txt')!.status).toBe('A')
      expect(diff.working).toHaveLength(0)
    } finally {
      await removeWorktree(repo, wtPath, true)
    }
  })

  it('separates uncommitted changes and flags untracked files', async () => {
    const wtPath = path.join(tmp, 'wt-dirty')
    await addWorktree(repo, 'feature/thing', wtPath)
    try {
      await fs.writeFile(path.join(wtPath, 'a.txt'), 'dirty\n')
      await fs.writeFile(path.join(wtPath, 'brand-new.txt'), 'hello\n')

      const diff = await diffSummary(wtPath, 'main')
      const working = Object.fromEntries(diff.working.map((f) => [f.path, f]))

      expect(working['a.txt']!.untracked).toBe(false)
      expect(working['brand-new.txt']!.untracked).toBe(true)
      expect(working['brand-new.txt']!.status).toBe('A')
    } finally {
      await removeWorktree(repo, wtPath, true)
    }
  })

  it('produces patches for committed, working and untracked files', async () => {
    const wtPath = path.join(tmp, 'wt-patch')
    await addWorktree(repo, 'feature/thing', wtPath)
    try {
      const committed = await filePatch(wtPath, 'main', 'a.txt', 'committed', false)
      expect(committed).toContain('-one')
      expect(committed).toContain('+two')

      await fs.writeFile(path.join(wtPath, 'a.txt'), 'three\n')
      const working = await filePatch(wtPath, 'main', 'a.txt', 'working', false)
      expect(working).toContain('+three')

      // An untracked file has nothing to diff against; it must still render.
      await fs.writeFile(path.join(wtPath, 'fresh.txt'), 'fresh\n')
      const untracked = await filePatch(wtPath, 'main', 'fresh.txt', 'working', true)
      expect(untracked).toContain('+fresh')
    } finally {
      await removeWorktree(repo, wtPath, true)
    }
  })

  it('does not fail the whole view when the base ref is unknown', async () => {
    const diff = await diffSummary(repo, 'no-such-base')
    expect(diff.committed).toHaveLength(0)
    expect(diff.ahead).toBe(0)
  })
})
