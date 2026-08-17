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
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<FileContent | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (dir: string) => {
      setLoadingPaths((prev) => new Set(prev).add(dir))
      try {
        const res = await api.files(projectId, slug, dir, showAll)
        setCache((prev) => ({ ...prev, [dir]: res.entries }))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoadingPaths((prev) => {
          const next = new Set(prev)
          next.delete(dir)
          return next
        })
      }
    },
    [projectId, slug, showAll],
  )

  // Reset everything when the worktree or the noise filter changes.
  useEffect(() => {
    setCache({})
    setExpanded(new Set(['']))
    setSelected(null)
    setFile(null)
    void load('')
  }, [projectId, slug, showAll, load])

  const toggleDir = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else {
        next.add(dir)
        if (!cache[dir]) void load(dir)
      }
      return next
    })
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
      return loadingPaths.has(dir) ? (
        <div className="tree-row" style={{ paddingLeft: depth * 14 + 10 }}>
          <Spinner />
        </div>
      ) : null
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
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
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
