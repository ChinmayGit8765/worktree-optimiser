import { useState } from 'react'
import { api } from '../api'
import type { Detection, Project } from '../types'
import { Dialog, ErrorBox, Field, Spinner } from './ui'

/**
 * Two-step: point at a checkout, we inspect it and propose how to run it; you
 * confirm or adjust. Detection is always shown, never applied silently.
 */
export function AddProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (project: Project) => void
}) {
  const [repoPath, setRepoPath] = useState('')
  const [detection, setDetection] = useState<Detection | null>(null)
  const [workdir, setWorkdir] = useState('')
  const [worktreesRoot, setWorktreesRoot] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const detect = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.detect(repoPath)
      setDetection(result)
      setWorkdir(result.candidates[0]?.workdir ?? '')
      setWorktreesRoot(result.suggestedWorktreesRoot)
      setName(result.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? result.suggestedId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setDetection(null)
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    if (!detection) return
    setBusy(true)
    setError(null)
    try {
      const project = await api.createProject({
        repoPath: detection.repoPath,
        name,
        worktreesRoot,
        workdir,
      })
      onCreated(project)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const chosen = detection?.candidates.find((c) => c.workdir === workdir)

  return (
    <Dialog
      title="Add a project"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {detection ? (
            <button className="btn primary" onClick={create} disabled={busy || !chosen}>
              {busy ? <Spinner /> : 'Add project'}
            </button>
          ) : (
            <button className="btn primary" onClick={detect} disabled={busy || !repoPath.trim()}>
              {busy ? <Spinner /> : 'Inspect repo'}
            </button>
          )}
        </>
      }
    >
      <Field
        label="Repository path"
        hint="Absolute path to an existing clone on this machine."
      >
        <input
          type="text"
          value={repoPath}
          placeholder="C:\dev\my-app"
          spellCheck={false}
          onChange={(e) => setRepoPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !detection && repoPath.trim() && void detect()}
        />
      </Field>

      <ErrorBox message={error} />

      {detection && (
        <>
          {detection.notes.map((note) => (
            <div className="note" key={note}>
              {note}
            </div>
          ))}

          <Field label="Display name">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field
            label="App to run"
            hint={
              chosen
                ? `${chosen.framework} · port ${chosen.containerPort} · ${chosen.packageManager}`
                : undefined
            }
          >
            <select value={workdir} onChange={(e) => setWorkdir(e.target.value)}>
              {detection.candidates.map((c) => (
                <option key={c.workdir} value={c.workdir}>
                  {c.workdir === '' ? 'repo root' : c.workdir} — {c.framework}
                </option>
              ))}
            </select>
          </Field>

          {chosen && (
            <Field label="Commands">
              <div
                className="mono"
                style={{
                  background: 'var(--bg-inset)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '8px 10px',
                  fontSize: 12,
                  color: 'var(--text-dim)',
                }}
              >
                <div>image: {detection.image}</div>
                {chosen.install && <div>install: {chosen.install}</div>}
                <div>dev: {chosen.dev}</div>
              </div>
            </Field>
          )}

          <Field
            label="Worktrees directory"
            hint="Where new branch checkouts are created. Kept outside the repo on purpose."
          >
            <input
              type="text"
              value={worktreesRoot}
              spellCheck={false}
              onChange={(e) => setWorktreesRoot(e.target.value)}
            />
          </Field>
        </>
      )}
    </Dialog>
  )
}
