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

  if (me.status === 'loading') return <p>Loading…</p>
  if (me.status === 'unauthenticated') return <Navigate to="/signin" />
  if (me.status === 'error') return <p>Error: {me.message}</p>

  return (
    <div>
      <h1>Team & Repos</h1>

      {me.me.role === 'lead' ? (
        <ConnectRepoForm onConnected={loadRepos} />
      ) : (
        <p>Only a Lead can connect repos</p>
      )}

      {loadError && <p style={{ color: '#c00' }}>{loadError}</p>}

      {repos === null ? null : repos.length === 0 ? (
        <p>No repositories connected yet.</p>
      ) : (
        <ul>
          {repos.map((repo) => (
            <li key={repo.id}>
              <strong>{repo.fullName}</strong> <RepoStatus repo={repo} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function RepoStatus({ repo }: { repo: RepoSummary }) {
  if (repo.status === 'connecting') return <span>Importing open PRs…</span>

  const lastSynced = repo.lastSyncedAt
    ? `Last synced at ${new Date(repo.lastSyncedAt).toLocaleString()}`
    : 'Not synced yet'
  return (
    <span>
      {lastSynced}
      {repo.syncStatus !== 'ok' && (
        <span style={{ color: '#c00' }}> · sync {repo.syncStatus.replace('_', ' ')}</span>
      )}
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
    <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
      <input
        aria-label="Owner"
        placeholder="owner"
        value={owner}
        onChange={(e) => setOwner(e.target.value)}
        required
      />
      <span>/</span>
      <input
        aria-label="Repository name"
        placeholder="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <button type="submit" disabled={submitting}>
        {submitting ? 'Connecting…' : 'Connect'}
      </button>
      {error && <span style={{ color: '#c00' }}>{error}</span>}
    </form>
  )
}
