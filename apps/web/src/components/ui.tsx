import { useEffect, type ReactNode } from 'react'
import type { ContainerStatus } from '../types'

export function StatusDot({ status }: { status: ContainerStatus }) {
  return <span className={`dot ${status}`} title={status} />
}

export function statusLabel(status: ContainerStatus): string {
  switch (status) {
    case 'running':
      return 'running'
    case 'exited':
      return 'stopped'
    case 'absent':
      return 'no container'
    default:
      return status
  }
}

export function Dialog({
  title,
  children,
  footer,
  onClose,
}: {
  title: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="content">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null
  return <div className="error">{message}</div>
}

export function Spinner() {
  return <span className="spin">◐</span>
}
