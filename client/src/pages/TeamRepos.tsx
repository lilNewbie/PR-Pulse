// Owned by Kaushik
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { apiFetch } from '../api/client'
import { useMe } from '../hooks/useMe'

// TODO (Alan): move to shared/types.ts; mirrors RepoSummary in server/src/modules/team-repo.
interface RepoSummary {
  id: number
  fullName: string
  status: 'connecting' | 'connected'
  syncStatus: 'ok' | 'rate_limited' | 'failed'
  lastSyncedAt: string | null
}

const POLL_MS = 3000

export default function TeamRepos() {
  const me = useMe()
  const [repos, setRepos] = useState<RepoSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadRepos = useCallback(() => {
    apiFetch<{ items: RepoSummary[] }>('/api/repos')
      .then((res) => {
        setRepos(res.items)
        setLoadError(null)
      })
      .catch((err: Error) => setLoadError(err.message))
  }, [])

  useEffect(() => {
    if (me.status === 'ok') loadRepos()
  }, [me.status, loadRepos])

  // Poll while an initial import is running so the repo flips to connected on its own.
  const importing = repos?.some((repo) => repo.status === 'connecting') ?? false
  useEffect(() => {
    if (!importing) return
    const timer = setInterval(loadRepos, POLL_MS)
    return () => clearInterval(timer)
  }, [importing, loadRepos])

  if (me.status === 'loading') return <p className="text-muted">Loading…</p>
  if (me.status === 'unauthenticated') return <Navigate to="/signin" />
  if (me.status === 'error') return <p className="text-error">Error: {me.message}</p>

  return (
    <div>
      <h2 className="page-title">Team Repos</h2>

      {me.me.role === 'lead' ? (
        <ConnectRepoForm onConnected={loadRepos} />
      ) : (
        <p className="text-muted">Only a Lead can connect repos.</p>
      )}

      {loadError && <p className="text-error">{loadError}</p>}

      {repos === null ? null : repos.length === 0 ? (
        <p className="text-muted">No repositories connected yet.</p>
      ) : (
        <ul className="repo-list">
          {repos.map((repo) => (
            <li key={repo.id} className="repo-item">
              <span className="repo-name">{repo.fullName}</span>
              <RepoStatus repo={repo} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function RepoStatus({ repo }: { repo: RepoSummary }) {
  if (repo.status === 'connecting')
    return <span className="repo-status-text status-syncing">Importing open PRs…</span>

  const lastSynced = repo.lastSyncedAt
    ? `Last synced ${new Date(repo.lastSyncedAt).toLocaleString()}`
    : 'Not synced yet'

  return (
    <span className="repo-status-text">
      {repo.syncStatus !== 'ok' ? (
        <span className="status-error">Sync {repo.syncStatus.replace('_', ' ')} · </span>
      ) : (
        <span className="status-ok">✓ </span>
      )}
      {lastSynced}
    </span>
  )
}

function ConnectRepoForm({ onConnected }: { onConnected: () => void }) {
  const [owner, setOwner] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await apiFetch('/api/repos', { method: 'POST', body: JSON.stringify({ owner, name }) })
      setOwner('')
      setName('')
      onConnected()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="connect-form">
      <input
        aria-label="Owner"
        placeholder="owner"
        value={owner}
        onChange={(e) => setOwner(e.target.value)}
        required
      />
      <span className="connect-form-sep">/</span>
      <input
        aria-label="Repository name"
        placeholder="repo-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <button type="submit" disabled={submitting}>
        {submitting ? 'Connecting…' : 'Connect repo'}
      </button>
      {error && <span className="connect-form-error">{error}</span>}
    </form>
  )
}
