import { useEffect, useState } from 'react'
import { Link, useParams, Navigate } from 'react-router-dom'
import { apiFetch } from '../api/client'
import { useMe } from '../hooks/useMe'
import type { DeploymentDetail } from 'shared'

type State =
  | { status: 'loading' }
  | { status: 'ok'; data: DeploymentDetail }
  | { status: 'error'; message: string }

export default function DeploymentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const me = useMe()
  const [state, setState] = useState<State>({ status: 'loading' })

  const isLead = me.status === 'ok' && me.me.role === 'lead'

  useEffect(() => {
    if (!isLead || !id) return
    setState({ status: 'loading' })
    apiFetch<DeploymentDetail>(`/api/deployments/${id}`)
      .then((data) => setState({ status: 'ok', data }))
      .catch((err: unknown) =>
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Failed to load' }),
      )
  }, [isLead, id])

  if (me.status === 'loading') return <p className="text-muted">Loading…</p>
  if (me.status === 'unauthenticated') return <Navigate to="/signin" replace />
  if (me.status === 'error') return <p className="text-error">Error: {me.message}</p>
  if (!isLead) return <p className="text-error">Deployment details are available to Leads only.</p>

  if (state.status === 'loading') return <p className="text-muted">Loading…</p>
  if (state.status === 'error') return <p className="text-error">{state.message}</p>

  const dep = state.data

  return (
    <section>
      <h2 className="page-title">Deployment Detail</h2>

      <div className="connect-form">
        <span><strong>Environment</strong></span>
        <span>{dep.environment}</span>

        <span><strong>Status</strong></span>
        <span>
          {dep.status === 'failed'
            ? <span className="status-error">Failed</span>
            : dep.status === 'success'
            ? <span className="status-ok">Success</span>
            : <span className="status-syncing">Pending</span>}
        </span>

        <span><strong>SHA</strong></span>
        <span className="queue-mono">{dep.sha}</span>

        <span><strong>Date</strong></span>
        <span>{new Date(dep.createdAt).toLocaleString()}</span>

        <span><strong>Source</strong></span>
        <span>{dep.source}</span>

        <span><strong>Previous deploy</strong></span>
        <span>
          {dep.previousDeploymentId
            ? <Link to={`/deployments/${dep.previousDeploymentId}`}>#{dep.previousDeploymentId}</Link>
            : 'No previous deploy to compare'}
        </span>
      </div>

      <h3>Linked PRs</h3>
      {dep.prs.length === 0 ? (
        <p className="text-muted">No linked PR</p>
      ) : (
        <table className="queue-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Title</th>
              <th>Author</th>
              <th>Merged at</th>
            </tr>
          </thead>
          <tbody>
            {dep.prs.map((pr) => (
              <tr key={pr.number}>
                <td className="queue-mono">{pr.number}</td>
                <td><a href={pr.url} target="_blank" rel="noreferrer">{pr.title}</a></td>
                <td className="queue-mono">{pr.authorLogin}</td>
                <td className="queue-mono">{pr.mergedAt ? new Date(pr.mergedAt).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p style={{ marginTop: '1rem' }}>
        <Link to="/deployments">← Back to deployment history</Link>
      </p>
    </section>
  )
}
