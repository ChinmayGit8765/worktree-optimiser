import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { DirEntry, FileContent } from '../types'
import { ErrorBox, Spinner } from './ui'

/**
 * Lazy tree: children are fetched the first time a directory is expanded and then
 * cached. A worktree with node_modules has hundreds of thousands of entries, so
 * eager recursion is not an option (the API hides the noisy dirs by default too).
 */
export function FileTree({ projectId, slug }: { projectId: string; slug: string }) {
  const [cache, setCache] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<FileContent | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // No loading-flag state: "expanded but not in the cache yet" already means
  // loading, and deriving it avoids a synchronous setState before the fetch.
  const load = useCallback(
    async (dir: string) => {
      try {
        const res = await api.files(projectId, slug, dir, showAll)
        setCache((prev) => ({ ...prev, [dir]: res.entries }))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [projectId, slug, showAll],
  )

  // Only the fetch lives in the effect. The component is mounted with a key of
  // the worktree slug, so switching worktrees remounts it; the noise filter is a
  // user action and resets state in its own handler below.
  useEffect(() => {
    // `load` awaits the request before touching state, so nothing is set
    // synchronously here; the rule cannot see past the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load('')
  }, [load])

  const toggleDir = (dir: string) => {
    // The fetch is kicked off here rather than inside the setState updater: an
    // updater must be pure, and React may call it more than once.
    const opening = !expanded.has(dir)
    if (opening && !cache[dir]) void load(dir)

    const next = new Set(expanded)
    if (opening) next.add(dir)
    else next.delete(dir)
    setExpanded(next)
  }

  const openFile = async (path: string) => {
    setSelected(path)
    setFile(null)
    try {
      setFile(await api.file(projectId, slug, path))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const renderDir = (dir: string, depth: number) => {
    const entries = cache[dir]
    if (!entries) {
      return (
        <div className="tree-row" style={{ paddingLeft: depth * 14 + 10 }}>
          <Spinner />
        </div>
      )
    }
    return entries.map((entry) => {
      const isOpen = expanded.has(entry.path)
      return (
        <div key={entry.path}>
          <button
            className={`tree-row${selected === entry.path ? ' active' : ''}`}
            style={{ paddingLeft: depth * 14 + 10 }}
            onClick={() => (entry.type === 'dir' ? toggleDir(entry.path) : void openFile(entry.path))}
            title={entry.path}
          >
            <span className="caret">{entry.type === 'dir' ? (isOpen ? '▾' : '▸') : ''}</span>
            <span className={entry.type === 'dir' ? 'dirname' : 'filename'}>{entry.name}</span>
            {entry.size !== null && <span className="size">{formatSize(entry.size)}</span>}
          </button>
          {entry.type === 'dir' && isOpen && renderDir(entry.path, depth + 1)}
        </div>
      )
    })
  }

  return (
    <div className="file-tree">
      <label className="checkbox" style={{ padding: '8px 10px' }}>
        <input
          type="checkbox"
          checked={showAll}
          onChange={(e) => {
            setCache({})
            setExpanded(new Set(['']))
            setSelected(null)
            setFile(null)
            setShowAll(e.target.checked)
          }}
        />
        show node_modules & build output
      </label>
      <ErrorBox message={error} />
      <div className="tree-scroll">{renderDir('', 0)}</div>

      {selected && (
        <div className="file-view">
          <div className="patch-head">
            {selected}
            {file?.truncated && <span className="badge dirty">truncated</span>}
          </div>
          {!file ? (
            <div className="inspector-pad"><Spinner /></div>
          ) : file.binary ? (
            <div className="inspector-pad" style={{ color: 'var(--text-faint)' }}>
              Binary file · {formatSize(file.size)}
            </div>
          ) : (
            <pre className="file-body">{file.content}</pre>
          )}
        </div>
      )}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
