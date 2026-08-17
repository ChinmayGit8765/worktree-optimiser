import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { AddProjectDialog } from './components/AddProjectDialog'
import { LogPanel } from './components/LogPanel'
import { Navigator } from './components/Navigator'
import { NewWorktreeDialog } from './components/NewWorktreeDialog'
import { WorktreeCard } from './components/WorktreeCard'
import { ErrorBox, Spinner } from './components/ui'
import type { Project, SystemStatus, Worktree } from './types'

const POLL_MS = 4000

export default function App() {
  const [system, setSystem] = useState<SystemStatus | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [busySlugs, setBusySlugs] = useState<Set<string>>(new Set())
  const [logSlug, setLogSlug] = useState<string | null>(null)
  const [showAddProject, setShowAddProject] = useState(false)
  const [showNewWorktree, setShowNewWorktree] = useState(false)
  const [view, setView] = useState<'grid' | 'navigator'>('grid')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  const setBusy = useCallback((slug: string, busy: boolean) => {
    setBusySlugs((prev) => {
      const next = new Set(prev)
      if (busy) next.add(slug)
      else next.delete(slug)
      return next
    })
  }, [])

  const refreshWorktrees = useCallback(async (projectId: string) => {
    try {
      const list = await api.worktrees(projectId)
      // Guard against a slow response for a project the user has navigated away from.
      if (activeIdRef.current === projectId) setWorktrees(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // Initial load
  useEffect(() => {
    void (async () => {
      try {
        const [sys, list] = await Promise.all([api.system(), api.projects()])
        setSystem(sys)
        setProjects(list)
        setActiveId((cur) => cur ?? list[0]?.id ?? null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // Poll the active project so container state stays honest without a refresh.
  useEffect(() => {
    if (!activeId) {
      setWorktrees([])
      return
    }
    void refreshWorktrees(activeId)
    const timer = setInterval(() => {
      void refreshWorktrees(activeId)
      void api.system().then(setSystem).catch(() => {})
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [activeId, refreshWorktrees])

  const act = useCallback(
    async (slug: string, fn: () => Promise<unknown>) => {
      setBusy(slug, true)
      setError(null)
      try {
        await fn()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(slug, false)
        if (activeIdRef.current) await refreshWorktrees(activeIdRef.current)
      }
    },
    [refreshWorktrees, setBusy],
  )

  const activeProject = projects.find((p) => p.id === activeId) ?? null
  const logWorktree = worktrees.find((w) => w.slug === logSlug) ?? null
  const runningCount = worktrees.filter((w) => w.status === 'running').length

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          worktree <span>optimiser</span>
        </h1>
        {system && (
          <>
            <span className="pill">
              <span className={`dot ${system.dockerOk ? 'running' : 'exited'}`} />
              docker {system.dockerVersion ?? 'unreachable'}
            </span>
            <span className="pill">
              <span className={`dot ${system.traefik.status === 'running' ? 'running' : 'exited'}`} />
              proxy :{system.traefik.httpPort}
            </span>
            {system.traefik.status !== 'running' && (
              <button
                className="btn sm"
                onClick={() => void api.startProxy().then(() => api.system().then(setSystem))}
              >
                Start proxy
              </button>
            )}
          </>
        )}
        <div className="spacer" />
        {activeProject && (
          <span className="pill">
            {runningCount}/{worktrees.length} running
          </span>
        )}
      </header>

      <div className="body">
        <nav className="sidebar">
          <div className="label">Projects</div>
          {projects.map((p) => (
            <button
              key={p.id}
              className={`project-btn${p.id === activeId ? ' active' : ''}`}
              onClick={() => {
                setActiveId(p.id)
                setLogSlug(null)
              }}
            >
              <span className="name">{p.name}</span>
              <span className="path" title={p.repoPath}>
                {p.repoPath}
              </span>
            </button>
          ))}
          {projects.length === 0 && !loading && (
            <p style={{ color: 'var(--text-faint)', fontSize: 12, padding: '0 8px' }}>
              No projects yet.
            </p>
          )}
          <button
            className="btn sm"
            style={{ marginTop: 8 }}
            onClick={() => setShowAddProject(true)}
          >
            + Add project
          </button>
        </nav>

        <main className={`main${view === 'navigator' && activeProject ? ' flush' : ''}`}>
          {system && !system.dockerOk && (
            <div className="error" style={{ marginBottom: 20 }}>
              Docker is not reachable: {system.dockerError}
              {'\n'}Start Docker Desktop, then reload.
            </div>
          )}

          <ErrorBox message={error} />

          {loading ? (
            <div className="empty">
              <Spinner />
            </div>
          ) : !activeProject ? (
            <div className="empty">
              <h3>No project selected</h3>
              <p>
                Register a repository and every branch you check out becomes its own containerised
                dev server on its own hostname.
              </p>
              <button className="btn primary" onClick={() => setShowAddProject(true)}>
                Add your first project
              </button>
            </div>
          ) : (
            <>
              <div className="section-head">
                <div>
                  <h2>{activeProject.name}</h2>
                  <div className="sub">
                    {activeProject.image} · {activeProject.workdir || 'repo root'} · port{' '}
                    {activeProject.containerPort}
                  </div>
                </div>
                <div className="spacer" />
                <div className="split-toggle">
                  <button
                    className={`btn sm${view === 'grid' ? ' primary' : ''}`}
                    onClick={() => setView('grid')}
                  >
                    Worktrees
                  </button>
                  <button
                    className={`btn sm${view === 'navigator' ? ' primary' : ''}`}
                    onClick={() => setView('navigator')}
                  >
                    Navigator
                  </button>
                </div>
                <button className="btn" onClick={() => setShowNewWorktree(true)}>
                  + New worktree
                </button>
              </div>

              {view === 'navigator' ? (
                <Navigator
                  projectId={activeProject.id}
                  worktrees={worktrees}
                  onStart={(slug) => void act(slug, () => api.start(activeProject.id, slug))}
                />
              ) : worktrees.length === 0 ? (
                <div className="empty">
                  <h3>No worktrees yet</h3>
                  <p>Create one from an existing branch, or start a new branch from here.</p>
                  <button className="btn primary" onClick={() => setShowNewWorktree(true)}>
                    New worktree
                  </button>
                </div>
              ) : (
                <div className="grid">
                  {worktrees.map((w) => (
                    <WorktreeCard
                      key={w.slug}
                      worktree={w}
                      busy={busySlugs.has(w.slug)}
                      actions={{
                        onStart: () => void act(w.slug, () => api.start(activeProject.id, w.slug)),
                        onStop: () => void act(w.slug, () => api.stop(activeProject.id, w.slug)),
                        onRestart: () =>
                          void act(w.slug, () => api.restart(activeProject.id, w.slug)),
                        onRebuild: () =>
                          void act(w.slug, () => api.start(activeProject.id, w.slug, true)),
                        onLogs: () => setLogSlug(w.slug === logSlug ? null : w.slug),
                        onDestroy: () => {
                          const warning = w.dirty
                            ? `${w.branch} has uncommitted changes. Remove the worktree and discard them?`
                            : `Remove the worktree for ${w.branch}? The branch itself is kept.`
                          if (!window.confirm(warning)) return
                          void act(w.slug, () =>
                            api.destroy(activeProject.id, w.slug, { force: w.dirty }),
                          )
                        },
                      }}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {logWorktree && activeProject && (
        <LogPanel
          projectId={activeProject.id}
          worktree={logWorktree}
          onClose={() => setLogSlug(null)}
        />
      )}

      {showAddProject && (
        <AddProjectDialog
          onClose={() => setShowAddProject(false)}
          onCreated={(project) => {
            setProjects((prev) => [...prev, project])
            setActiveId(project.id)
            setShowAddProject(false)
          }}
        />
      )}

      {showNewWorktree && activeProject && (
        <NewWorktreeDialog
          projectId={activeProject.id}
          onClose={() => setShowNewWorktree(false)}
          onCreated={() => {
            setShowNewWorktree(false)
            void refreshWorktrees(activeProject.id)
          }}
        />
      )}
    </div>
  )
}
