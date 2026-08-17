import { useMemo, useState } from 'react'
import type { Worktree } from '../types'
import { DiffView } from './DiffView'
import { FileTree } from './FileTree'
import { StatusDot } from './ui'

const VIEWPORTS = [
  { label: 'Fill', width: null },
  { label: 'Desktop', width: 1280 },
  { label: 'Tablet', width: 834 },
  { label: 'Mobile', width: 390 },
] as const

type InspectorTab = 'changes' | 'files' | null

function PreviewPane({
  worktree,
  path,
  nonce,
  width,
  focused,
  showFocusRing,
  onFocus,
  onStart,
}: {
  worktree: Worktree | null
  path: string
  nonce: number
  width: number | null
  focused: boolean
  showFocusRing: boolean
  onFocus: () => void
  onStart: (slug: string) => void
}) {
  if (!worktree) {
    return (
      <div className="pane empty-pane">
        <span>Pick a worktree from the rail above.</span>
      </div>
    )
  }

  const running = worktree.status === 'running'

  return (
    <div
      className={`pane${focused && showFocusRing ? ' focused' : ''}`}
      onMouseDown={onFocus}
    >
      <div className="pane-head">
        <StatusDot status={worktree.status} />
        <span className="pane-branch" title={worktree.branch}>
          {worktree.branch}
        </span>
        <a
          className="pane-url"
          href={`${worktree.url}${path}`}
          target="_blank"
          rel="noreferrer"
          title="Open in a new tab"
        >
          ↗
        </a>
      </div>

      <div className="pane-body">
        {running ? (
          <div className="pane-viewport" style={width ? { width, maxWidth: '100%' } : undefined}>
            {/*
              Remounting via `key` is how reload works. Appending a cache-busting
              query param would change the URL the app actually sees, which breaks
              routing assertions and shows up in the address bar of the preview.
            */}
            <iframe
              key={`${worktree.slug}-${nonce}-${path}`}
              src={`${worktree.url}${path}`}
              title={worktree.branch}
            />
          </div>
        ) : (
          <div className="pane-offline">
            <p>
              <code>{worktree.branch}</code> isn't running.
            </p>
            <button className="btn primary sm" onClick={() => onStart(worktree.slug)}>
              Start it
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function Navigator({
  projectId,
  worktrees,
  onStart,
}: {
  projectId: string
  worktrees: Worktree[]
  onStart: (slug: string) => void
}) {
  const [split, setSplit] = useState<1 | 2>(1)
  /** Explicit user choices. null means "whatever the default resolves to". */
  const [chosen, setChosen] = useState<[string | null, string | null]>([null, null])
  const [focused, setFocused] = useState<0 | 1>(0)
  const [pathInput, setPathInput] = useState('/')
  const [appliedPath, setAppliedPath] = useState('/')
  const [viewport, setViewport] = useState<number | null>(null)
  const [nonce, setNonce] = useState(0)
  const [tab, setTab] = useState<InspectorTab>(null)

  const byslug = useMemo(() => new Map(worktrees.map((w) => [w.slug, w])), [worktrees])

  /**
   * Derived rather than synchronised into state by an effect. Storing a copy of
   * something computable from props means an extra render pass on every change
   * and a window where the two disagree; this just recomputes.
   */
  const slugs = useMemo<[string | null, string | null]>(() => {
    const keep = (s: string | null) => (s && byslug.has(s) ? s : null)
    const a =
      keep(chosen[0]) ??
      worktrees.find((w) => w.status === 'running')?.slug ??
      worktrees[0]?.slug ??
      null
    const b =
      keep(chosen[1]) ??
      worktrees.find((w) => w.status === 'running' && w.slug !== a)?.slug ??
      worktrees.find((w) => w.slug !== a)?.slug ??
      null
    return [a, b]
  }, [chosen, worktrees, byslug])

  const assign = (slug: string) => {
    setChosen(([a, b]) => (focused === 0 ? [slug, b] : [a, slug]))
  }

  const applyPath = () => {
    const next = pathInput.startsWith('/') ? pathInput : `/${pathInput}`
    setPathInput(next)
    setAppliedPath(next)
  }

  const panes: (Worktree | null)[] =
    split === 1
      ? [slugs[0] ? (byslug.get(slugs[0]) ?? null) : null]
      : [slugs[0] ? (byslug.get(slugs[0]) ?? null) : null, slugs[1] ? (byslug.get(slugs[1]) ?? null) : null]

  const focusedWorktree = panes[Math.min(focused, panes.length - 1)] ?? null

  return (
    <div className="navigator">
      <div className="rail">
        {worktrees.map((w) => {
          const paneIndex = slugs.indexOf(w.slug)
          const shown = split === 1 ? paneIndex === 0 : paneIndex >= 0
          return (
            <button
              key={w.slug}
              className={`chip${shown ? ' on' : ''}`}
              onClick={() => assign(w.slug)}
              title={
                shown
                  ? `Showing in pane ${paneIndex === 0 ? 'A' : 'B'}`
                  : `Show in pane ${focused === 0 ? 'A' : 'B'}`
              }
            >
              <StatusDot status={w.status} />
              <span>{w.branch}</span>
              {shown && <span className="pane-tag">{paneIndex === 0 ? 'A' : 'B'}</span>}
            </button>
          )
        })}
      </div>

      <div className="navbar">
        <div className="split-toggle">
          <button className={`btn sm${split === 1 ? ' primary' : ''}`} onClick={() => setSplit(1)}>
            1-up
          </button>
          <button className={`btn sm${split === 2 ? ' primary' : ''}`} onClick={() => setSplit(2)}>
            2-up
          </button>
        </div>

        <input
          className="path-input mono"
          value={pathInput}
          spellCheck={false}
          placeholder="/"
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && applyPath()}
          onBlur={applyPath}
          title="Path applied to every pane"
        />

        <button className="btn sm" onClick={() => setNonce((n) => n + 1)} title="Reload all panes">
          ⟳
        </button>

        <select
          className="viewport-select"
          value={String(viewport ?? '')}
          onChange={(e) => setViewport(e.target.value ? Number(e.target.value) : null)}
        >
          {VIEWPORTS.map((v) => (
            <option key={v.label} value={v.width ?? ''}>
              {v.label}
              {v.width ? ` · ${v.width}px` : ''}
            </option>
          ))}
        </select>

        <div className="spacer" />

        <button
          className={`btn sm${tab === 'changes' ? ' primary' : ''}`}
          onClick={() => setTab(tab === 'changes' ? null : 'changes')}
        >
          Changes
        </button>
        <button
          className={`btn sm${tab === 'files' ? ' primary' : ''}`}
          onClick={() => setTab(tab === 'files' ? null : 'files')}
        >
          Files
        </button>
      </div>

      <div className="nav-body">
        <div className={`panes split-${split}`}>
          {panes.map((w, i) => (
            <PreviewPane
              key={i}
              worktree={w}
              path={appliedPath}
              nonce={nonce}
              width={viewport}
              focused={focused === i}
              showFocusRing={split === 2}
              onFocus={() => setFocused(i as 0 | 1)}
              onStart={onStart}
            />
          ))}
        </div>

        {tab && (
          <aside className="inspector">
            <div className="inspector-head">
              <span className="title mono">{focusedWorktree?.branch ?? '—'}</span>
              <button className="btn ghost sm" onClick={() => setTab(null)} aria-label="Close">
                ✕
              </button>
            </div>
            {focusedWorktree ? (
              tab === 'changes' ? (
                // Keyed on the worktree so switching remounts and resets, rather
                // than clearing state from inside an effect.
                <DiffView
                  key={focusedWorktree.slug}
                  projectId={projectId}
                  slug={focusedWorktree.slug}
                />
              ) : (
                <FileTree
                  key={focusedWorktree.slug}
                  projectId={projectId}
                  slug={focusedWorktree.slug}
                />
              )
            ) : (
              <div className="inspector-pad">No worktree selected.</div>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}
