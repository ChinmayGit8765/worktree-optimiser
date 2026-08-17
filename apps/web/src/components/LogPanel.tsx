import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Worktree } from '../types'

/**
 * Live container output over SSE. Keeps a bounded buffer — a webpack build can
 * emit tens of thousands of lines and we'd otherwise pin the tab at 100% CPU.
 */
const MAX_LINES = 2000

export function LogPanel({
  projectId,
  worktree,
  onClose,
}: {
  projectId: string
  worktree: Worktree
  onClose: () => void
}) {
  const [lines, setLines] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const [follow, setFollow] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(follow)
  // Mirrored in an effect rather than during render: a render can be discarded,
  // and mutating a ref while that happens is not safe.
  useEffect(() => {
    followRef.current = follow
  }, [follow])

  // Mounted with a key of the worktree slug, so a different worktree remounts
  // this component and clears the buffer without an in-effect reset.
  useEffect(() => {
    const source = new EventSource(api.logsUrl(projectId, worktree.slug))
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    source.onmessage = (event) => {
      setLines((prev) => {
        const next = prev.length > MAX_LINES ? prev.slice(-MAX_LINES + 1) : prev.slice()
        next.push(event.data)
        return next
      })
    }

    return () => source.close()
  }, [projectId, worktree.slug])

  useEffect(() => {
    if (!followRef.current) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <aside className="log-panel">
      <header>
        <span className={`dot ${connected ? 'running' : 'absent'}`} />
        <span className="title">{worktree.containerName}</span>
        <label className="checkbox">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          follow
        </label>
        <button className="btn ghost sm" onClick={() => setLines([])}>
          clear
        </button>
        <button className="btn ghost sm" onClick={onClose} aria-label="Close logs">
          ✕
        </button>
      </header>
      <div
        className="log-body"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          if (atBottom !== followRef.current) setFollow(atBottom)
        }}
      >
        {lines.length === 0
          ? connected
            ? 'Waiting for output…'
            : 'No container running for this worktree.'
          : lines.join('\n')}
      </div>
    </aside>
  )
}
