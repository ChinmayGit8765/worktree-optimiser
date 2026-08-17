import { useEffect, useState } from 'react'
import { api } from '../api'
import type { DiffSummary, FileChange } from '../types'
import { ErrorBox, Spinner } from './ui'

type Origin = 'committed' | 'working'

interface Selection {
  file: FileChange
  origin: Origin
}

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
  const [loading, setLoading] = useState(true)
  const [patchLoading, setPatchLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setSelected(null)
    setPatch(null)
    api
      .diff(projectId, slug)
      .then((res) => !cancelled && setSummary(res))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [projectId, slug])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setPatchLoading(true)
    api
      .patch(projectId, slug, {
        path: selected.file.path,
        origin: selected.origin,
        untracked: selected.file.untracked,
      })
      .then((res) => !cancelled && setPatch(res.patch))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setPatchLoading(false))
    return () => {
      cancelled = true
    }
  }, [projectId, slug, selected])

  if (loading) return <div className="inspector-pad"><Spinner /></div>

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
                  onClick={() => setSelected({ file: f, origin: 'working' })}
                />
              ))}
            </>
          )}

          {summary.committed.length > 0 && (
            <>
              <div className="group-label">Committed vs {summary.base} ({summary.committed.length})</div>
              {summary.committed.map((f) => (
                <ChangeRow
                  key={`c-${f.path}`}
                  file={f}
                  active={selected?.origin === 'committed' && selected.file.path === f.path}
                  onClick={() => setSelected({ file: f, origin: 'committed' })}
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
            <div className="inspector-pad"><Spinner /></div>
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
