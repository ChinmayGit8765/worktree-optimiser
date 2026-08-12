import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { BranchRef, Worktree } from '../types'
import { Dialog, ErrorBox, Field, Spinner } from './ui'

export function NewWorktreeDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string
  onClose: () => void
  onCreated: (worktree: Worktree) => void
}) {
  const [branches, setBranches] = useState<BranchRef[]>([])
  const [defaultBranch, setDefaultBranch] = useState('')
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [selected, setSelected] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const [start, setStart] = useState(true)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .branches(projectId)
      .then((res) => {
        if (cancelled) return
        setBranches(res.branches)
        setDefaultBranch(res.defaultBranch)
        setBaseRef(res.defaultBranch)
        const first = res.branches.find((b) => !b.checkedOutAt)
        setSelected(first?.name ?? '')
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [projectId])

  // A branch can live in exactly one worktree, so anything already checked out
  // is not a valid choice — show it, but disabled, so the absence isn't confusing.
  const available = useMemo(() => branches.filter((b) => !b.checkedOutAt), [branches])

  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.fetchRemote(projectId)
      setBranches(res.branches)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const worktree = await api.createWorktree(projectId, {
        branch: mode === 'new' ? newBranch.trim() : selected,
        createBranch: mode === 'new',
        baseRef: mode === 'new' ? baseRef : undefined,
        start,
      })
      onCreated(worktree)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = mode === 'new' ? newBranch.trim().length > 0 : selected.length > 0

  return (
    <Dialog
      title="New worktree"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={refresh} disabled={busy}>
            Fetch remotes
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy || !canSubmit}>
            {busy ? <Spinner /> : start ? 'Create & start' : 'Create'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className={`btn sm${mode === 'existing' ? ' primary' : ''}`}
          onClick={() => setMode('existing')}
        >
          Existing branch
        </button>
        <button
          className={`btn sm${mode === 'new' ? ' primary' : ''}`}
          onClick={() => setMode('new')}
        >
          New branch
        </button>
      </div>

      <ErrorBox message={error} />

      {mode === 'existing' ? (
        <Field
          label="Branch"
          hint={
            loading
              ? 'Loading branches…'
              : `${available.length} available · ${branches.length - available.length} already checked out`
          }
        >
          <select value={selected} onChange={(e) => setSelected(e.target.value)} disabled={loading}>
            {available.length === 0 && <option value="">No available branches</option>}
            {available.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name} {b.kind === 'remote' ? '(remote)' : ''} — {b.head}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <>
          <Field label="New branch name" hint="Created from the base ref below.">
            <input
              type="text"
              value={newBranch}
              placeholder="feature/my-thing"
              spellCheck={false}
              onChange={(e) => setNewBranch(e.target.value)}
            />
          </Field>
          <Field label="Base ref" hint={`Defaults to ${defaultBranch || 'the default branch'}.`}>
            <input
              type="text"
              value={baseRef}
              spellCheck={false}
              onChange={(e) => setBaseRef(e.target.value)}
            />
          </Field>
        </>
      )}

      <label className="checkbox">
        <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} />
        Start the container immediately (installs dependencies first — the first run is slow)
      </label>
    </Dialog>
  )
}
