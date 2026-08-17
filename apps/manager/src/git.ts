import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { HttpError } from './store.js'

const exec = promisify(execFile)

export interface GitWorktree {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
}

export interface BranchRef {
  name: string
  /** Present locally, only on a remote, or both. */
  kind: 'local' | 'remote'
  head: string
  subject: string
  /** ISO date of the tip commit. */
  date: string
  /** Worktree path currently holding this branch, if any. */
  checkedOutAt: string | null
}

async function git(cwd: string, args: string[], allowExitCodes: number[] = []): Promise<string> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    })
    return stdout
  } catch (err: unknown) {
    // `git diff --no-index` and friends signal "there is a difference" with exit
    // code 1, which is a result rather than a failure.
    const code = (err as { code?: number }).code
    if (typeof code === 'number' && allowExitCodes.includes(code)) {
      return (err as { stdout?: string }).stdout ?? ''
    }
    const e = err as { stderr?: string; message?: string }
    const detail = (e.stderr || e.message || String(err)).trim()
    throw new HttpError(400, `git ${args.join(' ')} failed: ${detail}`)
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ['rev-parse', '--is-inside-work-tree'])
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/** Top level of the checkout that `dir` belongs to. */
export async function toplevel(dir: string): Promise<string> {
  const out = await git(dir, ['rev-parse', '--show-toplevel'])
  return path.resolve(out.trim())
}

export async function currentBranch(dir: string): Promise<string | null> {
  const out = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  return out === 'HEAD' ? null : out
}

export async function defaultBranch(repoPath: string): Promise<string> {
  // origin/HEAD is the honest answer when it exists; otherwise fall back to
  // whatever conventional name actually resolves.
  try {
    const out = (await git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
    const name = out.replace(/^origin\//, '')
    if (name) return name
  } catch {
    /* no origin/HEAD; fall through */
  }
  for (const candidate of ['main', 'master', 'develop']) {
    try {
      await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`])
      return candidate
    } catch {
      /* try next */
    }
  }
  return (await currentBranch(repoPath)) ?? 'HEAD'
}

export async function listWorktrees(repoPath: string): Promise<GitWorktree[]> {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain'])
  const trees: GitWorktree[] = []
  let cur: Partial<GitWorktree> | null = null

  const flush = () => {
    if (cur?.path) {
      trees.push({
        path: path.resolve(cur.path),
        head: cur.head ?? null,
        branch: cur.branch ?? null,
        detached: cur.detached ?? false,
        bare: cur.bare ?? false,
        locked: cur.locked ?? false,
        prunable: cur.prunable ?? false,
      })
    }
    cur = null
  }

  for (const line of out.split(/\r?\n/)) {
    if (line === '') {
      flush()
      continue
    }
    const [key, ...rest] = line.split(' ')
    const value = rest.join(' ')
    if (key === 'worktree') {
      flush()
      cur = { path: value }
    } else if (!cur) {
      continue
    } else if (key === 'HEAD') {
      cur.head = value
    } else if (key === 'branch') {
      cur.branch = value.replace(/^refs\/heads\//, '')
    } else if (key === 'detached') {
      cur.detached = true
    } else if (key === 'bare') {
      cur.bare = true
    } else if (key === 'locked') {
      cur.locked = true
    } else if (key === 'prunable') {
      cur.prunable = true
    }
  }
  flush()
  return trees
}

export async function listBranches(repoPath: string): Promise<BranchRef[]> {
  const fmt = '%(refname)\t%(objectname:short)\t%(committerdate:iso-strict)\t%(contents:subject)'
  const out = await git(repoPath, [
    'for-each-ref',
    `--format=${fmt}`,
    '--sort=-committerdate',
    'refs/heads',
    'refs/remotes',
  ])

  const worktrees = await listWorktrees(repoPath)
  const checkedOut = new Map<string, string>()
  for (const wt of worktrees) if (wt.branch) checkedOut.set(wt.branch, wt.path)

  const byName = new Map<string, BranchRef>()
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [refname = '', head = '', date = '', ...subjectParts] = line.split('\t')
    const subject = subjectParts.join('\t')

    if (refname.startsWith('refs/heads/')) {
      const name = refname.slice('refs/heads/'.length)
      byName.set(name, {
        name,
        kind: 'local',
        head,
        subject,
        date,
        checkedOutAt: checkedOut.get(name) ?? null,
      })
    } else if (refname.startsWith('refs/remotes/')) {
      const full = refname.slice('refs/remotes/'.length)
      // Skip the origin/HEAD pointer; it's an alias, not a branch.
      if (/\/HEAD$/.test(full)) continue
      const name = full.replace(/^[^/]+\//, '')
      // A local branch of the same name always wins.
      if (byName.has(name)) continue
      byName.set(name, {
        name,
        kind: 'remote',
        head,
        subject,
        date,
        checkedOutAt: null,
      })
    }
  }

  return [...byName.values()].sort((a, b) => b.date.localeCompare(a.date))
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

export async function remoteBranchExists(repoPath: string, branch: string): Promise<string | null> {
  const out = await git(repoPath, ['for-each-ref', '--format=%(refname)', 'refs/remotes'])
  for (const line of out.split(/\r?\n/)) {
    const ref = line.trim().replace(/^refs\/remotes\//, '')
    if (!ref || /\/HEAD$/.test(ref)) continue
    if (ref.replace(/^[^/]+\//, '') === branch) return ref
  }
  return null
}

export interface AddWorktreeOptions {
  /** Create the branch if it doesn't exist yet. */
  createBranch?: boolean
  /** Start point for a newly created branch. Defaults to the repo default branch. */
  baseRef?: string
}

/**
 * Materialise `branch` at `targetPath`. Handles the three real cases: the branch
 * already exists locally, it only exists on a remote (track it), or it's brand new.
 */
export async function addWorktree(
  repoPath: string,
  branch: string,
  targetPath: string,
  opts: AddWorktreeOptions = {},
): Promise<void> {
  const existing = await listWorktrees(repoPath)
  const clash = existing.find((wt) => wt.branch === branch)
  if (clash) {
    throw new HttpError(
      409,
      `Branch "${branch}" is already checked out at ${clash.path}. Git allows a branch in only one worktree at a time.`,
    )
  }

  if (await branchExists(repoPath, branch)) {
    await git(repoPath, ['worktree', 'add', targetPath, branch])
    return
  }

  const remoteRef = await remoteBranchExists(repoPath, branch)
  if (remoteRef) {
    await git(repoPath, ['worktree', 'add', '--track', '-b', branch, targetPath, remoteRef])
    return
  }

  if (!opts.createBranch) {
    throw new HttpError(
      404,
      `Branch "${branch}" does not exist locally or on any remote. Pass createBranch to make it.`,
    )
  }

  const base = opts.baseRef || (await defaultBranch(repoPath))
  await git(repoPath, ['worktree', 'add', '-b', branch, targetPath, base])
}

export async function removeWorktree(
  repoPath: string,
  targetPath: string,
  force = false,
): Promise<void> {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(targetPath)
  await git(repoPath, args)
}

export async function pruneWorktrees(repoPath: string): Promise<void> {
  await git(repoPath, ['worktree', 'prune'])
}

export async function fetchAll(repoPath: string): Promise<void> {
  await git(repoPath, ['fetch', '--all', '--prune'])
}

export interface WorkingState {
  head: string | null
  dirty: boolean
  /** Files with uncommitted changes. */
  changedFiles: number
  ahead: number
  behind: number
}

export interface FileChange {
  path: string
  /** A added, M modified, D deleted, T type-changed, U unmerged. */
  status: string
  additions: number | null
  deletions: number | null
  binary: boolean
  untracked: boolean
}

export interface DiffSummary {
  base: string
  /** Commits on this branch not on base, and vice versa. */
  ahead: number
  behind: number
  /** Committed on this branch since diverging from base. */
  committed: FileChange[]
  /** Uncommitted changes in the working tree, including untracked files. */
  working: FileChange[]
}

/**
 * Rename detection is deliberately off (`--no-renames`). Git renders renames with
 * a `src/{a => b}.ts` brace syntax in numstat that is genuinely ambiguous to parse
 * back into a path; showing a rename as a delete plus an add is honest and safe.
 */
function parseNumstat(out: string): Map<string, { additions: number | null; deletions: number | null }> {
  const map = new Map<string, { additions: number | null; deletions: number | null }>()
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [add = '', del = '', ...rest] = parts
    const file = rest.join('\t')
    const binary = add === '-' || del === '-'
    map.set(file, {
      additions: binary ? null : Number(add),
      deletions: binary ? null : Number(del),
    })
  }
  return map
}

function parseNameStatus(out: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [status = '', ...rest] = line.split('\t')
    const file = rest.join('\t')
    if (file) map.set(file, status.charAt(0))
  }
  return map
}

export async function diffSummary(
  worktreePath: string,
  base: string,
): Promise<DiffSummary> {
  // `base...HEAD` compares against the merge base, so unrelated commits landing on
  // base afterwards don't show up as changes this branch made.
  const range = `${base}...HEAD`

  let ahead = 0
  let behind = 0
  try {
    const counts = await git(worktreePath, ['rev-list', '--left-right', '--count', range])
    const m = /(\d+)\s+(\d+)/.exec(counts)
    if (m) {
      behind = Number(m[1])
      ahead = Number(m[2])
    }
  } catch {
    // base ref may not exist locally; fall through with zeroes
  }

  const committed: FileChange[] = []
  try {
    const [numstat, nameStatus] = await Promise.all([
      git(worktreePath, ['diff', '--numstat', '--no-renames', range]),
      git(worktreePath, ['diff', '--name-status', '--no-renames', range]),
    ])
    const counts = parseNumstat(numstat)
    for (const [file, status] of parseNameStatus(nameStatus)) {
      const c = counts.get(file)
      committed.push({
        path: file,
        status,
        additions: c?.additions ?? null,
        deletions: c?.deletions ?? null,
        binary: c ? c.additions === null : false,
        untracked: false,
      })
    }
  } catch {
    // unresolvable base; leave committed empty rather than failing the whole view
  }

  const [workingNumstat, porcelain] = await Promise.all([
    git(worktreePath, ['diff', '--numstat', '--no-renames', 'HEAD']).catch(() => ''),
    git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']),
  ])
  const workingCounts = parseNumstat(workingNumstat)

  const working: FileChange[] = []
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue
    const xy = line.slice(0, 2)
    const file = line.slice(3).replace(/^"|"$/g, '')
    const untracked = xy === '??'
    const c = workingCounts.get(file)
    working.push({
      path: file,
      status: untracked ? 'A' : (xy.trim().charAt(0) ?? 'M'),
      additions: c?.additions ?? null,
      deletions: c?.deletions ?? null,
      binary: c ? c.additions === null : false,
      untracked,
    })
  }

  return { base, ahead, behind, committed, working }
}

export type DiffOrigin = 'committed' | 'working'

export async function filePatch(
  worktreePath: string,
  base: string,
  relPath: string,
  origin: DiffOrigin,
  untracked: boolean,
): Promise<string> {
  if (untracked) {
    // An untracked file has nothing to diff against; --no-index against the null
    // device renders it as an all-additions patch. It exits 1 to mean "differs".
    return git(worktreePath, ['diff', '--no-index', '--', '/dev/null', relPath], [1])
  }
  const args =
    origin === 'committed'
      ? ['diff', '--no-renames', `${base}...HEAD`, '--', relPath]
      : ['diff', '--no-renames', 'HEAD', '--', relPath]
  return git(worktreePath, args, [1])
}

export async function workingState(worktreePath: string): Promise<WorkingState> {
  const out = await git(worktreePath, ['status', '--porcelain=v2', '--branch'])
  let head: string | null = null
  let ahead = 0
  let behind = 0
  let changedFiles = 0

  for (const line of out.split(/\r?\n/)) {
    if (!line) continue
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim()
      head = oid === '(initial)' ? null : oid.slice(0, 8)
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line)
      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
    } else if (!line.startsWith('#')) {
      changedFiles++
    }
  }

  return { head, dirty: changedFiles > 0, changedFiles, ahead, behind }
}
