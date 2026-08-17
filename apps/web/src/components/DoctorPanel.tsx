import { useEffect, useState } from 'react'
import type { DoctorReport } from '../types'
import { Dialog, ErrorBox, Spinner } from './ui'

/** Preflight results. The point is that a failure names its own fix. */
export function DoctorPanel({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const run = () => {
    setLoading(true)
    setError(null)
    fetch('/api/system/doctor')
      .then((r) => r.json())
      .then((r: DoctorReport & { error?: string }) => {
        if (r.error) setError(r.error)
        else setReport(r)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }

  useEffect(run, [])

  const failures = report?.checks.filter((c) => c.status === 'fail').length ?? 0
  const warnings = report?.checks.filter((c) => c.status === 'warn').length ?? 0

  return (
    <Dialog
      title="Preflight check"
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1, fontSize: 12, color: 'var(--text-faint)' }}>
            {report ? `${report.platform} · also available as \`npm run doctor\`` : ''}
          </span>
          <button className="btn" onClick={run} disabled={loading}>
            {loading ? <Spinner /> : 'Re-run'}
          </button>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <ErrorBox message={error} />

      {loading && !report ? (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <Spinner />
        </div>
      ) : report ? (
        <>
          <div className={failures ? 'error' : 'note'}>
            {failures === 0
              ? `No blocking problems${warnings ? `, ${warnings} warning(s)` : ''}.`
              : `${failures} problem(s) will stop worktrees from working.`}
          </div>

          <div className="doctor-list">
            {report.checks.map((check) => (
              <div key={`${check.id}-${check.label}`} className={`doctor-row ${check.status}`}>
                <span className="mark">
                  {check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '✕'}
                </span>
                <div className="body">
                  <div className="label">{check.label}</div>
                  <div className="detail">{check.detail}</div>
                  {check.fix && <div className="fix">{check.fix}</div>}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </Dialog>
  )
}
