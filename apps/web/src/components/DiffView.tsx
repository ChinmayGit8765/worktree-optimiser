import { useEffect, useState } from 'react'
import { api } from '../api'
import type { DiffSummary, FileChange } from '../types'
import { ErrorBox, Spinner } from './ui'

type Origin = 'committed' | 'working'

interface Selection {
  file: FileChange
  origin: Origin
}

/**
 * Mounted with a `key` of the worktree slug, so switching worktrees remounts and
 * resets naturally. That is why nothing here clears state in an effect: doing so
 * costs an extra render pass and is what the key is for.
 */

/** Unified-diff renderer. Colours by leading character; no syntax highlighting. */
function Patch({ text }: { text: string }) {
  const lines = text.split(/\r?\n/)
  return (
    <div className="patch">
      {lines.map((line, i) => {
        let cls = 'ctx'
        if (line.startsWith('+++') || line.startsWith('---')) cls = 'meta'
        else if (line.startsWith('@@')) cls = 'hunk'
        else if (line.startsWith('diff ') || line.startsWith('index ')) cls = 'meta'
        else if (line.startsWith('+')) cls = 'add'
        else if (line.startsWith('-')) cls = 'del'
        return (
          <div key={i} className={`patch-line ${cls}`}>
            {line || ' '}
          </div>
        )
      })}
    </div>
  )
}

function ChangeRow({
  file,
  active,
  onClick,
}: {
  file: FileChange
  active: boolean
  onClick: () => void
}) {
  return (
    <button className={`change-row${active ? ' active' : ''}`} onClick={onClick} title={file.path}>
      <span className={`status s-${file.status}`}>{file.status}</span>
      <span className="p">{file.path}</span>
      {file.binary ? (
        <span className="counts">bin</span>
      ) : (
        <span className="counts">
          {file.additions !== null && <span className="add">+{file.additions}</span>}
          {file.deletions !== null && <span className="del">−{file.deletions}</span>}
        </span>
      )}
    </button>
  )
}

export function DiffView({ projectId, slug }: { projectId: string; slug: string }) {
  const [summary, setSummary] = useState<DiffSummary | null>(null)
  const [selected, setSelected] = useState<Selection | null>(null)
  const [patch, setPatch] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Derived, not stored: a separate loading flag would need a synchronous
  // setState inside the effect to stay in step with the fetch.
  const loading = summary === null && error === null
  const patchLoading = selected !== null && patch === null

  useEffect(() => {
    let cancelled = false
    api
      .diff(projectId, slug)
      .then((res) => !cancelled && setSummary(res))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [projectId, slug])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    api
      .patch(projectId, slug, {
        path: selected.file.path,
        origin: selected.origin,
        untracked: selected.file.untracked,
      })
      .then((res) => !cancelled && setPatch(res.patch))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [projectId, slug, selected])

  const select = (file: FileChange, origin: Origin) => {
    setPatch(null)
    setSelected({ file, origin })
  }

  if (loading) {
    return (
      <div className="inspector-pad">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="diff-view">
      <ErrorBox message={error} />
      {summary && (
        <>
          <div className="diff-meta">
            vs <code>{summary.base}</code>
            <span className="badge">↑{summary.ahead}</span>
            <span className="badge">↓{summary.behind}</span>
          </div>

          {summary.working.length > 0 && (
            <>
              <div className="group-label">Uncommitted ({summary.working.length})</div>
              {summary.working.map((f) => (
                <ChangeRow
                  key={`w-${f.path}`}
                  file={f}
                  active={selected?.origin === 'working' && selected.file.path === f.path}
                  onClick={() => select(f, 'working')}
                />
              ))}
            </>
          )}

          {summary.committed.length > 0 && (
            <>
              <div className="group-label">
                Committed vs {summary.base} ({summary.committed.length})
              </div>
              {summary.committed.map((f) => (
                <ChangeRow
                  key={`c-${f.path}`}
                  file={f}
                  active={selected?.origin === 'committed' && selected.file.path === f.path}
                  onClick={() => select(f, 'committed')}
                />
              ))}
            </>
          )}

          {summary.working.length === 0 && summary.committed.length === 0 && (
            <div className="inspector-pad" style={{ color: 'var(--text-faint)' }}>
              No changes against {summary.base}.
            </div>
          )}
        </>
      )}

      {selected && (
        <div className="patch-wrap">
          <div className="patch-head">{selected.file.path}</div>
          {patchLoading ? (
            <div className="inspector-pad">
              <Spinner />
            </div>
          ) : patch ? (
            <Patch text={patch} />
          ) : (
            <div className="inspector-pad" style={{ color: 'var(--text-faint)' }}>
              No textual diff (binary or empty).
            </div>
          )}
        </div>
      )}
    </div>
  )
}
