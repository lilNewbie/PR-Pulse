// Owned by Kaushik. US-15 Explain reviewer expertise: route /expertise, any role.
import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import type { ExpertiseArea, ExpertiseResponse } from 'shared'
import { apiFetch } from '../api/client'
import { useMe } from '../hooks/useMe'

type ExpertiseState =
  | { status: 'idle' | 'loading' }
  | { status: 'loaded'; areas: ExpertiseArea[] }
  | { status: 'error'; message: string }

function relativeAge(dateStr: string): string {
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000)
  if (days === 0)   return 'today'
  if (days === 1)   return 'yesterday'
  if (days < 30)    return `${days}d ago`
  if (days < 365)   return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

function AreaPath({ path }: { path: string }) {
  const slash = path.lastIndexOf('/')
  if (slash === -1) return <span className="area-leaf">{path}</span>
  return (
    <>
      <span className="area-prefix">{path.slice(0, slash + 1)}</span>
      <span className="area-leaf">{path.slice(slash + 1)}</span>
    </>
  )
}

/** Presentational, exported so the empty state is easy to test. */
export function ExpertiseTable({ areas }: { areas: ExpertiseArea[] }) {
  if (areas.length === 0) {
    return (
      <div className="expertise-empty">
        <span className="expertise-empty-icon">◎</span>
        <p>No contribution history in this repository</p>
      </div>
    )
  }

  const maxCommits = Math.max(...areas.map((a) => a.commits), 1)

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="queue-table">
        <thead>
          <tr>
            <th>Area</th>
            <th>Commits</th>
            <th>Last commit</th>
          </tr>
        </thead>
        <tbody>
          {areas.map((area) => {
            const stale = (Date.now() - new Date(area.lastCommitAt).getTime()) > 90 * 86_400_000
            return (
              <tr key={area.area}>
                <td className="queue-mono expertise-area-cell">
                  <AreaPath path={area.area} />
                </td>
                <td className="expertise-commits-cell">
                  <div className="expertise-bar-row">
                    <div className="expertise-bar-bg">
                      <div
                        className="expertise-bar-fill"
                        style={{ width: `${Math.round((area.commits / maxCommits) * 100)}%` }}
                      />
                    </div>
                    <span className="expertise-commit-count">{area.commits}</span>
                  </div>
                </td>
                <td className="queue-mono">
                  <time dateTime={area.lastCommitAt}>
                    {new Date(area.lastCommitAt).toLocaleDateString()}
                  </time>
                  <span className={stale ? 'date-relative date-relative--stale' : 'date-relative'}>
                    {relativeAge(area.lastCommitAt)}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function Expertise() {
  const me = useMe()
  const [repoChoice, setRepoChoice] = useState<number | null>(null)
  const [state, setState] = useState<ExpertiseState>({ status: 'idle' })

  const repos = me.status === 'ok' ? me.me.repos : []
  const selectedRepoId = repos.some((repo) => repo.id === repoChoice)
    ? repoChoice
    : (repos[0]?.id ?? null)

  useEffect(() => {
    if (selectedRepoId === null) return

    let cancelled = false
    setState({ status: 'loading' })
    apiFetch<ExpertiseResponse>(`/api/me/expertise?repoId=${selectedRepoId}`)
      .then((body) => {
        if (!cancelled) setState({ status: 'loaded', areas: body.areas })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Could not load expertise',
          })
        }
      })
    return () => { cancelled = true }
  }, [selectedRepoId])

  if (me.status === 'loading') return <p className="text-muted">Loading…</p>
  if (me.status === 'unauthenticated') return <Navigate to="/signin" replace />
  if (me.status === 'error') return <p className="text-error">Error: {me.message}</p>

  return (
    <section>
      <h2 className="page-title">My Expertise</h2>
      {selectedRepoId === null ? (
        <p className="text-muted">No repositories you can access.</p>
      ) : (
        <>
          <div className="repo-picker">
            <label htmlFor="expertise-repo" className="repo-picker-label">Repository</label>
            <select
              id="expertise-repo"
              className="repo-picker-select"
              value={selectedRepoId}
              onChange={(event) => setRepoChoice(Number(event.target.value))}
            >
              {repos.map((repo) => (
                <option key={repo.id} value={repo.id}>{repo.fullName}</option>
              ))}
            </select>
          </div>
          {state.status === 'loaded' ? (
            <ExpertiseTable areas={state.areas} />
          ) : state.status === 'error' ? (
            <p className="text-error">{state.message}</p>
          ) : (
            <p className="text-muted">Loading expertise…</p>
          )}
        </>
      )}
    </section>
  )
}
