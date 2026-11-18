import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMe } from '../hooks/useMe'
import { apiFetch, ApiClientError } from '../api/client'
import type { QueueResponse, Flags } from 'shared'
import SuggestedForYou from '../components/SuggestedForYou'

type QueueState =
  | { status: 'loading' }
  | { status: 'ok'; data: QueueResponse }
  | { status: 'error'; message: string }

function waitSeverity(hours: number) {
  if (hours >= 72) return 'critical'
  if (hours >= 24) return 'high'
  if (hours >= 4)  return 'mid'
  return 'low'
}

function sizeChip(lines: number) {
  if (lines >= 500) return { label: `XL · ${lines}`, cls: 'badge-danger' }
  if (lines >= 200) return { label: `L · ${lines}`,  cls: 'badge-warn' }
  if (lines >= 50)  return { label: `M · ${lines}`,  cls: 'badge-muted' }
  return                   { label: `S · ${lines}`,  cls: 'badge-muted' }
}

function FlagBadges({ flags, isReleaseBlocker }: { flags: Flags; isReleaseBlocker: boolean }) {
  const chips = []
  if (isReleaseBlocker)          chips.push(<span key="rb"  className="badge badge-danger">🔒 Release blocker</span>)
  if (flags.stale)               chips.push(<span key="st"  className="badge badge-warn">Stale</span>)
  if (flags.conflict === 'yes')  chips.push(<span key="cf"  className="badge badge-danger">Conflict</span>)
  if (flags.conflict === 'checking') chips.push(<span key="ck" className="badge badge-muted">Checking…</span>)
  if (flags.behindBy > 0)        chips.push(<span key="bh"  className="badge badge-warn">Behind {flags.behindBy}</span>)
  if (chips.length === 0) return null
  return <div className="queue-flags">{chips}</div>
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
              <th>Repo · Author</th>
              <th>Wait</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const size = sizeChip(item.linesChanged)
              return (
                <tr key={item.id} className={item.isReleaseBlocker ? 'queue-row--blocker' : ''}>
                  <td className="queue-rank-cell">
                    <span className="rank-badge">{item.position}</span>
                  </td>
                  <td className="queue-title-cell">
                    <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a>
                    <FlagBadges flags={item.flags} isReleaseBlocker={item.isReleaseBlocker} />
                  </td>
                  <td className="queue-meta-cell">
                    <span className="queue-mono">{item.repo}</span>
                    <span className="queue-author">@{item.authorLogin}</span>
                  </td>
                  <td>
                    <span className={`wait-pill wait-pill--${waitSeverity(item.waitingHours)}`}>
                      ⏱ {item.waitingHours}h
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${size.cls}`}>{size.label}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {/* US-11, US-19, US-20: suggestions are for Reviewers and Leads; the API returns 403 to PR Authors. */}
      {me.me.role !== 'pr_author' && (
        <div style={{ marginTop: '2rem' }}>
          <SuggestedForYou />
        </div>
      )}
    </div>
  )
}
