import type { Worktree } from '../types'
import { Spinner, StatusDot, statusLabel } from './ui'

export interface WorktreeActions {
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  onRebuild: () => void
  onLogs: () => void
  onDestroy: () => void
}

export function WorktreeCard({
  worktree,
  busy,
  actions,
}: {
  worktree: Worktree
  busy: boolean
  actions: WorktreeActions
}) {
  const running = worktree.status === 'running'
  const hasContainer = worktree.status !== 'absent'
  const orphaned = worktree.path === '(worktree missing)'

  return (
    <article className={`card${running ? ' is-running' : ''}`}>
      <div className="card-head">
        <StatusDot status={worktree.status} />
        <div className="title">
          <div className="branch" title={worktree.branch}>
            {worktree.branch}
          </div>
          <div className="meta">
            <span>{busy ? <Spinner /> : statusLabel(worktree.status)}</span>
            {worktree.head && <code>{worktree.head}</code>}
            {worktree.dirty && <span className="badge dirty">uncommitted</span>}
            {worktree.primary && <span className="badge primary">primary</span>}
            {orphaned && <span className="badge dirty">orphaned</span>}
          </div>
        </div>
      </div>

      <div className="card-url">
        {running ? (
          <a href={worktree.url} target="_blank" rel="noreferrer" title={worktree.url}>
            {worktree.url.replace(/^https?:\/\//, '')}
          </a>
        ) : (
          <span style={{ color: 'var(--text-faint)' }}>
            {worktree.url.replace(/^https?:\/\//, '')}
          </span>
        )}
      </div>

      {/*
        The direct loopback URL. Always works, even where *.localhost does not
        resolve, so it is shown rather than hidden behind a tooltip.
      */}
      {worktree.localUrl && (
        <div className="card-url alt">
          {running ? (
            <a href={worktree.localUrl} target="_blank" rel="noreferrer">
              {worktree.localUrl.replace(/^https?:\/\//, '')}
            </a>
          ) : (
            <span style={{ color: 'var(--text-faint)' }}>
              {worktree.localUrl.replace(/^https?:\/\//, '')}
            </span>
          )}
          <span className="badge">direct</span>
        </div>
      )}

      <div className="card-actions">
        {running ? (
          <button className="btn sm" onClick={actions.onStop} disabled={busy}>
            Stop
          </button>
        ) : (
          <button className="btn sm primary" onClick={actions.onStart} disabled={busy || orphaned}>
            Start
          </button>
        )}
        <button className="btn sm" onClick={actions.onRestart} disabled={busy || !hasContainer}>
          Restart
        </button>
        <button
          className="btn sm"
          onClick={actions.onRebuild}
          disabled={busy || orphaned}
          title="Recreate the container so it picks up changed project settings"
        >
          Rebuild
        </button>
        <button className="btn sm" onClick={actions.onLogs} disabled={!hasContainer}>
          Logs
        </button>
        <button
          className="btn sm danger"
          onClick={actions.onDestroy}
          disabled={busy || worktree.primary}
          title={worktree.primary ? 'The primary checkout cannot be removed' : 'Remove worktree'}
        >
          Remove
        </button>
      </div>

      <div className="meta" style={{ color: 'var(--text-faint)', fontSize: 11 }}>
        <code title={worktree.path}>{worktree.path}</code>
      </div>
    </article>
  )
}
