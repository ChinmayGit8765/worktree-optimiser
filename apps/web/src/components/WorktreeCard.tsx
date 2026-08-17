import { useState } from 'react'
import { api } from '../api'
import type { Diagnosis, Worktree } from '../types'
import { Spinner, StatusDot, statusLabel } from './ui'

export interface WorktreeActions {
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  onRebuild: () => void
  onLogs: () => void
  onDestroy: () => void
}

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (!Number.isFinite(seconds)) return ''
  const units: Array<[number, string]> = [
    [60, 's'],
    [3600, 'm'],
    [86400, 'h'],
    [2592000, 'd'],
  ]
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`
  for (let i = 1; i < units.length; i++) {
    if (seconds < units[i]![0]) return `${Math.floor(seconds / units[i - 1]![0])}${units[i - 1]![1]} ago`
  }
  return `${Math.floor(seconds / 2592000)}mo ago`
}

export function WorktreeCard({
  worktree,
  projectId,
  busy,
  actions,
}: {
  worktree: Worktree
  projectId: string
  busy: boolean
  actions: WorktreeActions
}) {
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null)
  const [diagnosing, setDiagnosing] = useState(false)

  const running = worktree.status === 'running'
  const hasContainer = worktree.status !== 'absent'
  const orphaned = worktree.path === '(worktree missing)'
  const working = busy || worktree.busy

  const diagnose = async () => {
    setDiagnosing(true)
    try {
      setDiagnosis(await api.diagnose(projectId, worktree.slug))
    } catch (err) {
      setDiagnosis({
        code: 'error',
        severity: 'error',
        title: 'Could not run diagnostics',
        detail: err instanceof Error ? err.message : String(err),
        listening: [],
        probeStatus: null,
        exitCode: null,
        warnings: [],
      })
    } finally {
      setDiagnosing(false)
    }
  }

  return (
    <article className={`card${running ? ' is-running' : ''}`}>
      <div className="card-head">
        <StatusDot status={worktree.status} />
        <div className="title">
          <div className="branch" title={worktree.branch}>
            {worktree.branch}
          </div>
          <div className="meta">
            <span>{working ? <Spinner /> : statusLabel(worktree.status)}</span>
            {worktree.head && <code>{worktree.head}</code>}
            {/* An agent working this branch needs to know whether its change is live. */}
            {worktree.dirty && (
              <span className="badge dirty">
                {worktree.changedFiles} uncommitted
              </span>
            )}
            {worktree.ahead > 0 && <span className="badge">↑{worktree.ahead}</span>}
            {worktree.behind > 0 && <span className="badge">↓{worktree.behind}</span>}
            {worktree.primary && <span className="badge primary">primary</span>}
            {orphaned && <span className="badge dirty">orphaned</span>}
          </div>
          {worktree.lastCommit && (
            <div className="commit" title={worktree.lastCommit.subject}>
              {worktree.lastCommit.subject}
              <span className="when"> · {relativeTime(worktree.lastCommit.date)}</span>
            </div>
          )}
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

      {diagnosis && (
        <div className={`diagnosis ${diagnosis.severity}`}>
          <div className="d-title">
            {diagnosis.title}
            <button className="btn ghost sm" onClick={() => setDiagnosis(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
          <div className="d-detail">{diagnosis.detail}</div>
          {diagnosis.fix && <div className="d-fix">{diagnosis.fix}</div>}
          {diagnosis.listening.length > 0 && (
            <div className="d-ports">
              listening inside container:{' '}
              {diagnosis.listening.map((l) => `${l.address}:${l.port}`).join(', ')}
            </div>
          )}
          {diagnosis.warnings.map((w) => (
            <div className="d-warn" key={w.code}>
              <strong>{w.title}</strong> — {w.fix}
            </div>
          ))}
        </div>
      )}

      <div className="card-actions">
        {running ? (
          <button className="btn sm" onClick={actions.onStop} disabled={working}>
            Stop
          </button>
        ) : (
          <button className="btn sm primary" onClick={actions.onStart} disabled={working || orphaned}>
            Start
          </button>
        )}
        <button className="btn sm" onClick={actions.onRestart} disabled={working || !hasContainer}>
          Restart
        </button>
        <button
          className="btn sm"
          onClick={actions.onRebuild}
          disabled={working || orphaned}
          title="Recreate the container so it picks up changed project settings"
        >
          Rebuild
        </button>
        <button className="btn sm" onClick={actions.onLogs} disabled={!hasContainer}>
          Logs
        </button>
        <button
          className="btn sm"
          onClick={() => void diagnose()}
          disabled={diagnosing || !hasContainer}
          title="Work out why this worktree is not serving"
        >
          {diagnosing ? <Spinner /> : 'Diagnose'}
        </button>
        <button
          className="btn sm danger"
          onClick={actions.onDestroy}
          disabled={working || worktree.primary}
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
