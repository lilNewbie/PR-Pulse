import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMe } from '../hooks/useMe'
import { apiFetch, ApiClientError } from '../api/client'
import type { QueueResponse, Flags } from 'shared'

type QueueState =
  | { status: 'loading' }
  | { status: 'ok'; data: QueueResponse }
  | { status: 'error'; message: string }

function FlagBadges({ flags }: { flags: Flags }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {flags.stale && <span className="badge badge-warn">Stale</span>}
      {flags.conflict === 'yes' && <span className="badge badge-danger">Conflict</span>}
      {flags.conflict === 'checking' && <span className="badge badge-muted">Checking…</span>}
      {flags.behindBy > 0 && <span className="badge badge-warn">Behind {flags.behindBy}</span>}
    </div>
  )
}

export default function ReviewQueue() {
  const navigate = useNavigate()
  const me = useMe()
  const [queue, setQueue] = useState<QueueState>({ status: 'loading' })

  useEffect(() => {
    if (me.status !== 'ok') return
    apiFetch<QueueResponse>('/api/queue')
      .then((data) => setQueue({ status: 'ok', data }))
      .catch((err) => {
        if (err instanceof ApiClientError && err.status === 401) {
          navigate('/signin')
        } else {
          setQueue({ status: 'error', message: err.message })
        }
      })
  }, [me.status, navigate])

  if (me.status === 'loading') return <p className="text-muted">Loading…</p>

  if (me.status === 'unauthenticated') {
    navigate('/signin')
    return null
  }

  if (me.status === 'error') return <p className="text-error">Error: {me.message}</p>

  if (queue.status === 'loading') return <p className="text-muted">Loading…</p>
  if (queue.status === 'error') return <p className="text-error">Error: {queue.message}</p>

  const { items, syncWarning, lastSyncedAt } = queue.data

  return (
    <div>
      <h2 className="page-title">Review Queue</h2>
      {syncWarning && (
        <div className="sync-warning">
          ⚠ Repositories out of sync — last synced{' '}
          {lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : 'unknown'}
        </div>
      )}
      {items.length === 0 ? (
        <p className="text-muted">Nothing to review right now.</p>
      ) : (
        <table className="queue-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Title</th>
              <th>Repo</th>
              <th>Author</th>
              <th>Waiting</th>
              <th>Lines</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td className="queue-mono">{item.position}</td>
                <td><a href={item.url} target="_blank" rel="noreferrer">{item.title}</a></td>
                <td className="queue-mono">{item.repo}</td>
                <td className="queue-mono">{item.authorLogin}</td>
                <td className="queue-mono">{item.waitingHours}h</td>
                <td className="queue-mono">{item.linesChanged}</td>
                <td><FlagBadges flags={item.flags} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
