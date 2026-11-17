import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import type { DeploymentSummary } from 'shared'
import { apiFetch } from '../api/client'
import { useMe } from '../hooks/useMe'

type EnvironmentFilter = 'all' | DeploymentSummary['environment']

type HistoryState =
  | { status: 'idle' | 'loading' }
  | { status: 'loaded'; items: DeploymentSummary[] }
  | { status: 'error'; message: string }

/** Presentational component exported so the no-deployments state is easy to test. */
export function DeploymentHistoryResults({ items }: { items: DeploymentSummary[] }) {
  if (items.length === 0) {
    return <p className="text-muted">No deployments recorded for this repository</p>
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="queue-table">
        <thead>
          <tr>
            <th>Environment</th>
            <th>Date</th>
            <th>Status</th>
            <th>Source</th>
            <th>PRs</th>
            <th>Deployment</th>
          </tr>
        </thead>
        <tbody>
          {items.map((deployment) => (
            <tr key={deployment.id}>
              <td>{deployment.environment}</td>
              <td className="queue-mono">
                <time dateTime={deployment.createdAt}>
                  {new Date(deployment.createdAt).toLocaleString()}
                </time>
              </td>
              <td>
                <span className={deployment.status === 'failed' ? 'status-error' : deployment.status === 'success' ? 'status-ok' : 'status-syncing'}>
                  {deployment.status === 'failed' ? 'Failed' : deployment.status === 'success' ? 'Success' : 'Pending'}
                </span>
              </td>
              <td>{deployment.source}</td>
              <td>{deployment.prCount}</td>
              <td><Link to={`/deployments/${deployment.id}`}>View details</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function Deployments() {
  const me = useMe()
  const [repoChoice, setRepoChoice] = useState<number | null>(null)
  const [environment, setEnvironment] = useState<EnvironmentFilter>('all')
  const [history, setHistory] = useState<HistoryState>({ status: 'idle' })

  const isLead = me.status === 'ok' && me.me.role === 'lead'
  const repos = me.status === 'ok' ? me.me.repos : []
  const selectedRepoId = repos.some((repo) => repo.id === repoChoice)
    ? repoChoice
    : (repos[0]?.id ?? null)

  useEffect(() => {
    if (!isLead || selectedRepoId === null) return

    let cancelled = false
    setHistory({ status: 'loading' })
    const params = new URLSearchParams({ repoId: String(selectedRepoId) })
    if (environment !== 'all') params.set('environment', environment)

    apiFetch<DeploymentSummary[]>(`/api/deployments?${params.toString()}`)
      .then((items) => {
        if (!cancelled) setHistory({ status: 'loaded', items })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setHistory({
            status: 'error',
            message: error instanceof Error ? error.message : 'Could not load deployment history',
          })
        }
      })
    return () => { cancelled = true }
  }, [isLead, selectedRepoId, environment])

  if (me.status === 'loading') return <p className="text-muted">Loading…</p>
  if (me.status === 'unauthenticated') return <Navigate to="/signin" replace />
  if (me.status === 'error') return <p className="text-error">Error: {me.message}</p>
  if (!isLead) return <p className="text-error">Deployment history is available to Leads only.</p>

  return (
    <section>
      <h2 className="page-title">Deployment History</h2>
      {selectedRepoId === null ? (
        <p className="text-muted">No repositories you can access.</p>
      ) : (
        <>
          <div className="connect-form">
            <label htmlFor="deployment-repo">Repository</label>
            <select
              id="deployment-repo"
              value={selectedRepoId}
              onChange={(event) => setRepoChoice(Number(event.target.value))}
            >
              {repos.map((repo) => (
                <option key={repo.id} value={repo.id}>{repo.fullName}</option>
              ))}
            </select>
            <label htmlFor="deployment-environment">Environment</label>
            <select
              id="deployment-environment"
              value={environment}
              onChange={(event) => setEnvironment(event.target.value as EnvironmentFilter)}
            >
              <option value="all">All</option>
              <option value="staging">Staging</option>
              <option value="production">Production</option>
            </select>
          </div>
          {history.status === 'loaded' ? (
            <DeploymentHistoryResults items={history.items} />
          ) : history.status === 'error' ? (
            <p className="text-error">{history.message}</p>
          ) : (
            <p className="text-muted">Loading deployments…</p>
          )}
        </>
      )}
    </section>
  )
}
